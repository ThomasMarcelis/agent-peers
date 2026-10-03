"""Subprocess failures and dependency checks without a Hermes installation."""

from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
import importlib.util
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace

import pytest

from agent_peers import BridgeClient
from agent_peers import runtime
from hermes_helpers import ROOT


def client(code, receive=lambda message: None):
    return BridgeClient([sys.executable, "-u", "-c", code], receive)


def test_write_timeout_bounds_a_child_that_never_reads():
    bridge = client("import time; time.sleep(30)")
    started = time.monotonic()
    try:
        with pytest.raises(RuntimeError, match="timed out.*not retried"):
            bridge.call("send_peer", {"message": "x" * 900_000}, timeout=0.15)
        assert time.monotonic() - started < 2
        assert not bridge._pending
    finally:
        bridge.close()
    assert bridge._process.poll() is not None
    assert not bridge._delivery.is_alive()


def test_close_interrupts_a_blocked_write():
    bridge = client("import time; time.sleep(30)")
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(bridge.call, "send_peer", {"message": "x" * 900_000})
        deadline = time.monotonic() + 2
        while bridge._process is None:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        started = time.monotonic()
        bridge.close()
        with pytest.raises(RuntimeError):
            pending.result(timeout=2)
        assert time.monotonic() - started < 2
        assert bridge._process.poll() is not None


def test_response_timeout_and_late_reply_do_not_corrupt_next_request():
    bridge = client("""
import json, sys, time
for index, line in enumerate(sys.stdin):
    request = json.loads(line)
    if not index:
        time.sleep(0.2)
    print(json.dumps({'id': request['id'], 'result': request['params']}), flush=True)
""")
    try:
        with pytest.raises(RuntimeError, match="timed out.*not retried"):
            bridge.call("echo", {"first": True}, timeout=0.05)
        assert bridge.call("echo", {"second": True}, timeout=2) == {"second": True}
        assert not bridge._pending
    finally:
        bridge.close()


@pytest.mark.parametrize("expression", [repr("not-json\n"), repr("[]\n"), repr('{"id": []}\n'), "'x' * 1000001"],
                         ids=["invalid-json", "wrong-type", "invalid-id", "oversized"])
def test_malformed_child_output_cannot_hang_the_caller(expression):
    bridge = client(f"import sys; sys.stdin.readline(); sys.stdout.write({expression}); sys.stdout.flush()")
    try:
        with pytest.raises(RuntimeError, match="bridge exited"):
            bridge.call("echo", timeout=2)
    finally:
        bridge.close()
    assert bridge._process.poll() is not None


def test_fragmented_utf8_response_and_context_delivery():
    profile = ContextVar("profile")
    profile.set("profile-a")
    received = []
    done = threading.Event()

    def receive(message):
        received.append((profile.get(), message))
        done.set()

    bridge = client("""
import json, os, sys
request = json.loads(sys.stdin.readline())
response = (json.dumps({'id':request['id'], 'result':'hé🙂'}, ensure_ascii=False) + '\\n').encode()
for byte in response:
    os.write(1, bytes([byte]))
print(json.dumps({'method':'peer_message', 'params': {'message':'reply'}}), flush=True)
sys.stdin.read()
""", receive)
    profile.set("profile-b")
    try:
        assert bridge.call("echo") == "hé🙂"
        assert done.wait(2)
        assert received == [("profile-a", {"message": "reply"})]
    finally:
        bridge.close()


def test_crash_fails_once_and_next_explicit_request_restarts(tmp_path):
    marker = tmp_path / "started"
    bridge = client(f"""
from pathlib import Path
import json, sys
marker = Path({str(marker)!r})
request = json.loads(sys.stdin.readline())
if not marker.exists():
    marker.write_text('yes')
    sys.exit(1)
print(json.dumps({{'id': request['id'], 'result': 'restarted'}}), flush=True)
sys.stdin.read()
""")
    try:
        with pytest.raises(RuntimeError, match="not retried"):
            bridge.call("echo")
        bridge._process.wait(timeout=2)
        assert bridge.call("echo") == "restarted"
    finally:
        bridge.close()


def test_request_size_rejected_before_process_start():
    bridge = client("raise AssertionError('must not start')")
    try:
        with pytest.raises(ValueError, match="size limit"):
            bridge.call("echo", {"text": "🙂" * runtime.MAX_LINE})
        assert bridge._process is None
    finally:
        bridge.close()


def test_pending_requests_are_bounded(monkeypatch):
    monkeypatch.setattr(runtime, "PENDING_MAX", 1)
    bridge = client("import sys, time; sys.stdin.readline(); time.sleep(30)")
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(bridge.call, "first")
        deadline = time.monotonic() + 2
        while not bridge._pending:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        try:
            with pytest.raises(RuntimeError, match="too many pending.*no message was sent"):
                bridge.call("second")
        finally:
            bridge.close()
        with pytest.raises(RuntimeError):
            pending.result(timeout=2)


def test_bridge_environment_excludes_credentials_and_preloads(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-secret")
    monkeypatch.setenv("NODE_OPTIONS", "--require /untrusted.js")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/test/claude")
    assert "OPENAI_API_KEY" not in runtime.bridge_environment()
    assert "NODE_OPTIONS" not in runtime.bridge_environment()
    assert runtime.bridge_environment()["CLAUDE_CONFIG_DIR"] == "/test/claude"


def test_managed_node_resolution_and_version_validation(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    node = home / "node" / "bin" / "node"
    node.parent.mkdir(parents=True)
    node.write_text("#!/bin/sh\nexit 0\n")
    node.chmod(0o700)
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        assert kwargs["timeout"] <= 5
        return SimpleNamespace(returncode=0, stdout=b"v24.0.0\n")

    monkeypatch.setattr(runtime.subprocess, "run", run)
    monkeypatch.setattr(runtime.shutil, "which", lambda name: None)
    assert runtime.default_command(hermes_home=home)[0] == str(node)
    assert calls[1][1:4] == ["--input-type=module", "-e", "await import(process.argv[1])"]


def test_dependency_failure_includes_exact_install_directory(tmp_path, monkeypatch):
    node = tmp_path / "node"
    node.write_text("#!/bin/sh\nexit 0\n")
    node.chmod(0o700)
    monkeypatch.setattr(runtime.shutil, "which", lambda name: str(node))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(runtime.subprocess, "run", lambda command, **kwargs:
                        SimpleNamespace(returncode=0 if "--version" in command else 1, stdout=b"v24.0.0\n"))
    with pytest.raises(RuntimeError, match="dependencies are unavailable") as exc:
        runtime.default_command(hermes_home=tmp_path / "empty")
    assert str(ROOT) in str(exc.value)
    assert "ci --omit=dev --ignore-scripts" in str(exc.value)


def test_unsupported_node_fails_clearly(tmp_path, monkeypatch):
    node = tmp_path / "node"
    node.write_text("#!/bin/sh\nexit 0\n")
    node.chmod(0o700)
    monkeypatch.setattr(runtime.shutil, "which", lambda name: str(node))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setattr(runtime.subprocess, "run", lambda *args, **kwargs:
                        SimpleNamespace(returncode=0, stdout=b"v20.0.0\n"))
    with pytest.raises(RuntimeError, match="Node.js 22 or newer"):
        runtime.default_command(hermes_home=tmp_path / "empty")


def test_compatibility_installer_uses_native_manager_only(monkeypatch):
    spec = importlib.util.spec_from_file_location("installer", ROOT / "scripts" / "install-hermes-plugin.py")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    commands = []
    monkeypatch.setattr(installer.shutil, "which", lambda name: "/usr/bin/hermes")
    monkeypatch.setattr(installer.subprocess, "call", lambda command: commands.append(command) or 0)
    pin = "a" * 40
    assert installer.main(["https://example.org/peers.git", "--profile", "test", "--ref", pin]) == 0
    assert commands == [["/usr/bin/hermes", "--profile", "test", "plugins", "install",
                         "https://example.org/peers.git", "--enable", "--ref", pin]]
