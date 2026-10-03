"""Integration checks against the pinned Hermes fork; opt in with its runner."""

from contextlib import contextmanager
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_helpers import ROOT, read_message, reply

pytestmark = pytest.mark.hermes_integration

def test_real_plugin_discovery_preserves_profile_scopes(tmp_path, monkeypatch, network):
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from tools.registry import registry
    import yaml

    @contextmanager
    def hermes_home_override(home):
        token = set_hermes_home_override(home)
        try:
            yield
        finally:
            reset_hermes_home_override(token)

    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(tmp_path / "no-bundled"))
    homes = [tmp_path / "profiles" / name for name in ("a", "b")]
    managers = []
    try:
        for home in homes:
            (home / "plugins").mkdir(parents=True)
            (home / "plugins" / "agent-peers").symlink_to(ROOT, target_is_directory=True)
            (home / "config.yaml").write_text(yaml.safe_dump({"plugins": {"enabled": ["agent-peers"]}}))
        handlers = []
        for home in (homes[0], homes[1], homes[0]):
            with hermes_home_override(home):
                discover_plugins()
                manager = get_plugin_manager()
                managers.append(manager)
                handler = registry.get_entry("send_peer", scope=manager.scope_key).handler
                handlers.append(handler)
                result = registry.dispatch("send_peer", {"to": "claude:test", "message": "hello"},
                                           scope=manager.scope_key, session_id="missing")
                assert json.loads(result) == {"error": "This conversation is no longer reachable for automatic peer replies."}
                listing = json.loads(registry.dispatch("list_peers", {}, scope=manager.scope_key))
                assert "error" not in listing
                assert "claude:test" in json.dumps(listing)
        assert handlers[0] is handlers[2]
        assert handlers[0] is not handlers[1]
    finally:
        for manager in set(managers):
            manager.unload()


@pytest.mark.asyncio
@pytest.mark.parametrize("busy", [False, True])
@pytest.mark.parametrize("parent_addressed", [False, True])
async def test_peer_replies_return_to_the_originating_discord_thread(
    tmp_path, monkeypatch, network, busy, parent_addressed,
):
    """Real plugin/socket/gateway/Discord send chain; only model and Discord HTTP are fake."""
    import asyncio
    from contextlib import nullcontext
    from unittest.mock import AsyncMock

    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.platforms.event import MessageEvent, MessageType
    from gateway.run import GatewayRunner
    from gateway.run_session_messages import close_session_message_routes, ensure_session_message_route
    from gateway.session import SessionSource, SessionStore
    from hermes_cli.plugins import get_plugin_manager
    from hermes_cli.session_messages import profile_message_scope
    from plugins.platforms.discord.adapter import DiscordAdapter
    from tools.registry import registry

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(tmp_path / "no-bundled"))
    monkeypatch.setenv("HERMES_ENABLE_PROJECT_PLUGINS", "0")
    home = tmp_path / "hermes"
    (home / "plugins").mkdir(parents=True)
    (home / "plugins" / "agent-peers").symlink_to(ROOT)
    (home / "config.yaml").write_text(
        "plugins:\n  enabled: [agent-peers]\n  entries:\n"
        "    agent-peers:\n      allow_gateway_injection: true\n")
    done = {thread: asyncio.Event() for thread in ("101", "102")}
    delivered, consumed = [], []
    channels = {}
    for thread in ("100", "101", "102"):
        async def send(*, content, reference=None, target=thread):
            delivered.append((target, content))
            if target in done:
                done[target].set()
            return SimpleNamespace(id=9000 + len(delivered))
        channels[int(thread)] = SimpleNamespace(id=int(thread), send=send)
    with profile_message_scope(home):
        manager = get_plugin_manager()
        manager.discover_and_load()
        adapter = DiscordAdapter(PlatformConfig(enabled=True, token="test", typing_indicator=False))
        adapter._client = SimpleNamespace(get_channel=channels.get, fetch_channel=AsyncMock())
        # Discord processing indicators and typing are unrelated network UI effects.
        adapter._run_processing_hook = AsyncMock()
        adapter._stop_typing_refresh = AsyncMock()
        store = SessionStore(sessions_dir=home / "sessions", config=GatewayConfig())
        runner = object.__new__(GatewayRunner)
        runner.config = GatewayConfig()
        runner.session_store = store
        runner.adapters = {Platform.DISCORD: adapter}
        runner._profile_adapters = {}
        runner._running = True
        runner._draining = False
        runner._running_agents = {}
        runner._queued_events = {}
        runner._is_user_authorized = lambda source, **kwargs: True
        runner._profile_scope_for_source = lambda source: nullcontext()
        entries = {}
        for thread in done:
            source = SessionSource(platform=Platform.DISCORD, chat_id="100" if parent_addressed else thread, thread_id=thread,
                                   parent_chat_id="100", chat_type="thread", user_id="42", guild_id="200")
            entry = store.get_or_create_session(source)
            entries[thread] = entry
            ensure_session_message_route(runner, source, entry.session_key, entry.session_id)
        assert entries["101"].session_id != entries["102"].session_id
        started, release = asyncio.Event(), asyncio.Event()

        async def model_turn(event):
            if event.text == "human request still running":
                started.set()
                await release.wait()
                return None
            consumed.append(event)
            assert event.metadata["gateway_session_id"] == entries[event.source.thread_id].session_id
            assert event.source.parent_chat_id == "100"
            assert event.internal and not event.allow_gateway_control
            assert "not from your user" in event.text
            return "Fable result A" if "reply-token-a" in event.text else "Fable result B"

        adapter.set_message_handler(model_turn)
        try:
            if busy:
                await adapter.handle_message(MessageEvent(
                    text="human request still running", message_type=MessageType.TEXT,
                    source=entries["101"].origin))
                await asyncio.wait_for(started.wait(), 5)
            addresses = {}
            for thread, entry in entries.items():
                result = json.loads(await asyncio.to_thread(
                    registry.dispatch, "send_peer", {"to": "claude:test", "message": f"request from {thread}"},
                    scope=manager.scope_key, session_id=entry.session_id))
                assert "error" not in result, result
                addresses[thread] = (await asyncio.to_thread(read_message, network.inbox))["from"]
            assert addresses["101"] != addresses["102"]
            # B is the more recently used thread. Reply there first, then to A's older inbox.
            reply("uds:" + str(network.sockets / "claude.sock"), addresses["102"], "reply-token-b")
            await asyncio.wait_for(done["102"].wait(), 5)
            reply("uds:" + str(network.sockets / "claude.sock"), addresses["101"], "reply-token-a")
            if busy:
                async def queued():
                    while entries["101"].session_key not in adapter._pending_messages:
                        await asyncio.sleep(0.01)
                await asyncio.wait_for(queued(), 5)
                assert not done["101"].is_set()
                release.set()
            await asyncio.wait_for(done["101"].wait(), 5)
            assert delivered == [("102", "Fable result B"), ("101", "Fable result A")]
            assert [event.source.thread_id for event in consumed] == ["102", "101"]
            listing = json.loads(await asyncio.to_thread(registry.dispatch, "list_peers", {}, scope=manager.scope_key))
            assert "hermes:" not in json.dumps(listing)
        finally:
            release.set()
            close_session_message_routes(runner)
            manager.unload()
            await adapter.cancel_background_tasks()


