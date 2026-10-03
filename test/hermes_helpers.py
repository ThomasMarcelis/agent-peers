"""Shared real-socket fixtures; no Hermes runtime imports."""

import json
import os
from pathlib import Path
import socket
import threading
from types import SimpleNamespace

import pytest

from agent_peers import plugin as plugin

ROOT = Path(__file__).resolve().parent.parent

@pytest.fixture
def network(tmp_path, monkeypatch):
    # A short socket directory matters on Linux (AF_UNIX's pathname limit is 108 bytes).
    import tempfile
    with tempfile.TemporaryDirectory(prefix="ap-") as short:
        sockets = Path(short)
        claude = tmp_path / "claude"
        (claude / "sessions").mkdir(parents=True)
        peers = tmp_path / "peers"
        peers.mkdir(mode=0o700)
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
        monkeypatch.setenv("AGENT_PEERS_HOME", str(peers))
        monkeypatch.setenv("AGENT_PEERS_CODEX_APP_SERVER", str(sockets / "no-daemon.sock"))
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
        inbox = socket.socket(socket.AF_UNIX)
        inbox.bind(str(sockets / "claude.sock"))
        os.chmod(sockets / "claude.sock", 0o600)
        inbox.listen()
        inbox.settimeout(5)
        (claude / "sessions" / f"{os.getpid()}.json").write_text(json.dumps({
            "pid": os.getpid(), "name": "test", "messagingSocketPath": str(sockets / "claude.sock"),
            "cwd": str(tmp_path), "status": "working",
        }))
        yield SimpleNamespace(sockets=sockets, peers=peers, inbox=inbox)
        inbox.close()


class Context:
    profile_name = "test-profile"

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

