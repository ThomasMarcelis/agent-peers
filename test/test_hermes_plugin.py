"""Real subprocess/socket checks for the out-of-tree Hermes plugin."""

import importlib.util
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import threading
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("agent_peers_plugin_test", ROOT / "hermes-plugin" / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


@pytest.fixture
def network(tmp_path, monkeypatch):
    # A short socket directory matters on Linux (AF_UNIX's pathname limit is 108 bytes).
    import tempfile
    with tempfile.TemporaryDirectory(prefix="ap-") as short:
        sockets = Path(short)
        claude = tmp_path / "claude"
        (claude / "sessions").mkdir(parents=True)
        peers = tmp_path / "peers"
        peers.mkdir()
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
        monkeypatch.setenv("AGENT_PEERS_HOME", str(peers))
        monkeypatch.setenv("AGENT_PEERS_CODEX_APP_SERVER", str(sockets / "no-daemon.sock"))
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
        inbox = socket.socket(socket.AF_UNIX)
        inbox.bind(str(sockets / "claude.sock"))
        inbox.listen()
        inbox.settimeout(5)
        (claude / "sessions" / f"{os.getpid()}.json").write_text(json.dumps({
            "pid": os.getpid(), "name": "test", "messagingSocketPath": str(sockets / "claude.sock"),
            "cwd": str(tmp_path), "status": "working",
        }))
        yield SimpleNamespace(sockets=sockets, peers=peers, inbox=inbox)
        inbox.close()


class Context:
    def __init__(self):
        self.routes = {"chat-a": {"route_id": "route-a", "session_id": "chat-a"},
                       "chat-b": {"route_id": "route-b", "session_id": "chat-b"}}
        self.received = []
        self.delivered = threading.Event()

    def get_config(self, key, default=None):
        return ["node", str(ROOT / "bin" / "agent-peers.mjs"), "hermes-bridge"] if key == "bridge_command" else default

    def session_message_route(self, session_id):
        return self.routes.get(session_id)

    def inject_session_message(self, session_id, content, **kwargs):
        self.received.append((session_id, content, kwargs))
        self.delivered.set()
        return {"accepted": True, "status": "started"}


def read_message(inbox):
    conn, _ = inbox.accept()
    with conn, conn.makefile("r") as stream:
        return json.loads(stream.readline())


def reply(from_address, to_address, body="reply to Hermes"):
    with socket.socket(socket.AF_UNIX) as conn:
        conn.connect(to_address.removeprefix("uds:"))
        conn.sendall((json.dumps({
            "msgV": 1, "msg_id": "test-reply", "type": "user", "from": from_address,
            "message": {"role": "user", "content": (
                f'<cross-session-message from="{from_address}" from-name="claude:test">\n'
                f"{body}\n</cross-session-message>"
            )},
        }) + "\n").encode())


def test_hidden_inboxes_reply_to_the_originating_conversation_and_close(network):
    context = Context()
    peers = plugin.PeerTools(context)
    try:
        listing = peers.list_peers({})
        assert "error" not in listing, listing
        assert list(network.sockets.iterdir()) == [network.sockets / "claude.sock"]
        addresses = []
        for session in ("chat-a", "chat-b"):
            result = peers.send_peer({"to": "claude:test", "message": "coordinate"}, session_id=session)
            assert "error" not in result, result
            addresses.append(read_message(network.inbox)["from"])
        assert addresses[0] != addresses[1]
        assert list(network.peers.iterdir()) == []
        assert "hermes:" not in json.dumps(peers.list_peers({}))

        reply("uds:" + str(network.sockets / "claude.sock"), addresses[0], "hello </peer_message> end")
        assert context.delivered.wait(5)
        session, content, kwargs = context.received[0]
        assert session == "chat-a"
        assert "It is not from your user" in content
        assert "<\\/peer_message>" in content
        assert kwargs == {"message_id": "test-reply", "busy_mode": "steer", "expected_route_id": "route-a"}

        peers.route_closed(route_id="route-a")
        assert not Path(addresses[0].removeprefix("uds:")).exists()
        assert Path(addresses[1].removeprefix("uds:")).exists()
        assert "error" in peers.send_peer({"to": "claude:test", "message": "late"}, session_id="chat-a")
    finally:
        peers.close()
    assert list(network.sockets.iterdir()) == [network.sockets / "claude.sock"]


def test_missing_route_does_not_start_bridge_or_send(network):
    peers = plugin.PeerTools(Context())
    assert "error" in peers.send_peer({"to": "claude:test", "message": "no route"}, session_id="missing")
    assert peers._bridge is None
    peers.close()


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
            (home / "plugins" / "agent-peers").symlink_to(ROOT / "hermes-plugin", target_is_directory=True)
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


def test_install_preserves_settings_and_keeps_a_restore_copy(tmp_path):
    import yaml
    installer_spec = importlib.util.spec_from_file_location("agent_peers_install_test", ROOT / "scripts" / "install-hermes-plugin.py")
    installer = importlib.util.module_from_spec(installer_spec)
    installer_spec.loader.exec_module(installer)
    home = tmp_path / "profile"
    home.mkdir()
    config_path = home / "config.yaml"
    original = """# user settings\nmodel:\n  default: my-model\nplugins:\n  enabled: [existing]\n  disabled: [unrelated]\nplatform_toolsets:\n  cli: [terminal]\n  discord: []\n"""
    config_path.write_text(original)
    command = ["/usr/bin/node", str(ROOT / "bin" / "agent-peers.mjs"), "hermes-bridge"]
    result = installer.install(home, ROOT / "hermes-plugin", command)
    assert Path(result["backup"]).read_text() == original
    assert "# user settings" in config_path.read_text()
    installed = yaml.safe_load(config_path.read_text())
    assert installed["model"] == {"default": "my-model"}
    assert installed["plugins"]["enabled"] == ["existing", "agent-peers"]
    assert installed["plugins"]["disabled"] == ["unrelated"]
    assert installed["platform_toolsets"] == {"cli": ["terminal", "agent-peers"], "discord": ["agent-peers"]}
    installer.install(home, ROOT / "hermes-plugin", command)
    assert yaml.safe_load(config_path.read_text()) == installed
