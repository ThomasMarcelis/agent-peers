"""Bounded subprocess transport and read-only runtime dependency checks."""

from __future__ import annotations

from concurrent.futures import Future, TimeoutError
from contextvars import copy_context
import json
import logging
import math
import os
from pathlib import Path
from queue import Empty, Full, Queue
import re
import select
import shlex
import shutil
import subprocess
import threading
import time

logger = logging.getLogger(__name__)
MAX_LINE = 1_000_000
QUEUE_MAX = 50
PENDING_MAX = 64
ROOT = Path(__file__).resolve().parent.parent
_EXITED = "agent-peers bridge exited; delivery is unknown and was not retried"
_TIMED_OUT = "agent-peers request timed out; delivery is unknown and was not retried"


def context_thread(target, *, name, args=()):
    """Carry public contextvars (including the host profile) into daemon workers."""
    context = copy_context()
    return threading.Thread(target=context.run, args=(target, *args), name=name, daemon=True)


def bridge_environment():
    # Discovery paths only; provider credentials and Node preload hooks stay out.
    return {key: os.environ[key] for key in (
        "PATH", "HOME", "XDG_RUNTIME_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
        "AGENT_PEERS_HOME", "AGENT_PEERS_CODEX_APP_SERVER",
    ) if key in os.environ}


def default_command(*, root=ROOT, hermes_home=None):
    """Resolve a usable system or Hermes-managed Node without changing either."""
    home = Path(hermes_home or os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    homes = [home]
    if home.parent.name == "profiles":
        homes.append(home.parent.parent)
    homes.append(Path.home() / ".hermes")
    candidates = [str(path / suffix) for path in homes for suffix in ("node/bin/node", "node/node")]
    if system := shutil.which("node"):
        candidates.append(system)
    env = bridge_environment()
    deadline = time.monotonic() + 5
    node = None
    for candidate in dict.fromkeys(candidates):
        if not os.access(candidate, os.X_OK) or not Path(candidate).is_file():
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            probe = subprocess.run([candidate, "--version"], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=env, timeout=min(1, remaining), check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        match = re.fullmatch(rb"v(\d+)\.\d+\.\d+\s*", probe.stdout)
        if probe.returncode == 0 and match and int(match[1]) >= 22:
            node = str(Path(candidate).absolute())
            break
    if node is None:
        raise RuntimeError("agent-peers requires Node.js 22 or newer on PATH or in the Hermes-managed node directory")
    bridge = root / "bin" / "agent-peers.mjs"
    if not bridge.is_file():
        raise RuntimeError(f"agent-peers bridge is missing at {bridge}; install the whole repository as a Hermes plugin")
    # Import the actual bridge module, without starting its stdin server. This
    # catches missing and incompatible dependencies before the first request.
    try:
        probe = subprocess.run([node, "--input-type=module", "-e", "await import(process.argv[1])",
                                (root / "src" / "hermes-bridge.mjs").as_uri()],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               env=env, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("agent-peers bridge dependency check failed or timed out") from None
    if probe.returncode:
        command = shlex.join(["npm", "--prefix", str(root), "ci", "--omit=dev", "--ignore-scripts"])
        raise RuntimeError(f"agent-peers bridge dependencies are unavailable; run: {command}")
    return [node, str(bridge), "hermes-bridge"]


class BridgeClient:
    """One subprocess per plugin/profile; writes and responses share a deadline."""

    def __init__(self, command: list[str], receive):
        if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
            raise ValueError("agent-peers bridge_command must be a nonempty executable/argument list")
        self.command = list(command)
        self.receive = receive
        self._environment = bridge_environment()
        self._lock = threading.RLock()
        self._write_lock = threading.Lock()
        self._process = None
        self._reader = None
        self._pending = {}
        self._next = 0
        self._stopped = False
        self._messages = Queue(maxsize=QUEUE_MAX)
        self._delivery = context_thread(self._deliver, name="agent-peers-delivery")
        self._delivery.start()

    def _start(self):
        # Called under both locks. Only this path creates processes or reuses FDs.
        if self._stopped:
            raise RuntimeError("agent-peers plugin has been unloaded")
        if self._process is not None:
            if self._process.poll() is None:
                return self._process
            self._process.stdin.close()
        process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=self._environment)
        os.set_blocking(process.stdin.fileno(), False)
        self._process = process
        self._reader = context_thread(self._read, name="agent-peers-reader", args=(process,))
        self._reader.start()
        return process

    def _fail_pending(self, process, message):
        with self._lock:
            for owner, future in list(self._pending.values()):
                if (process is None or owner is process) and not future.done():
                    future.set_exception(RuntimeError(message))

    def _write(self, process, data, deadline):
        view = memoryview(data)
        while view:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            if self._stopped or process.poll() is not None:
                raise BrokenPipeError()
            fd = process.stdin.fileno()
            if not select.select([], [fd], [], min(remaining, 0.1))[1]:
                continue
            try:
                written = os.write(fd, view)
            except BlockingIOError:
                continue
            if written <= 0:
                raise BrokenPipeError()
            view = view[written:]

    def call(self, method: str, params: dict | None = None, *, timeout: float = 25):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("agent-peers timeout must be positive and finite")
        deadline = time.monotonic() + timeout
        request_id = None
        if not self._write_lock.acquire(timeout=timeout):
            raise RuntimeError("agent-peers bridge is busy; no message was sent")
        try:
            with self._lock:
                if len(self._pending) >= PENDING_MAX:
                    raise RuntimeError("agent-peers has too many pending requests; no message was sent")
                self._next += 1
                request_id = self._next
                data = (json.dumps({"id": request_id, "method": method, "params": params or {}},
                                   ensure_ascii=False) + "\n").encode("utf-8")
                if len(data) > MAX_LINE:
                    raise ValueError("agent-peers request exceeds the message size limit")
                process = self._start()
                future = Future()
                self._pending[request_id] = (process, future)
            try:
                self._write(process, data, deadline)
            except (TimeoutError, OSError, ValueError) as exc:
                # A partially written frame cannot be reused safely.
                try:
                    process.terminate()
                except OSError:
                    pass
                message = _TIMED_OUT if isinstance(exc, TimeoutError) else _EXITED
                self._fail_pending(process, message)
                raise RuntimeError(message) from None
        except BaseException:
            with self._lock:
                self._pending.pop(request_id, None)
            raise
        finally:
            self._write_lock.release()
        try:
            return future.result(timeout=max(0, deadline - time.monotonic()))
        except TimeoutError:
            raise RuntimeError(_TIMED_OUT) from None
        finally:
            with self._lock:
                self._pending.pop(request_id, None)

    def _read(self, process):
        try:
            while not self._stopped:
                line = process.stdout.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE or not line.endswith(b"\n"):
                    logger.warning("agent-peers bridge exceeded the protocol line limit")
                    break
                try:
                    result = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeError):
                    logger.warning("agent-peers bridge returned invalid JSON")
                    break
                if not isinstance(result, dict):
                    continue
                if result.get("method") == "peer_message":
                    try:
                        self._messages.put_nowait(result.get("params", {}))
                    except Full:
                        logger.warning("agent-peers incoming queue is full; dropped peer message")
                    continue
                request_id = result.get("id")
                if type(request_id) is not int:
                    continue
                with self._lock:
                    pending = self._pending.get(request_id)
                    if pending and pending[0] is process and not pending[1].done():
                        error = result.get("error")
                        if error:
                            text = error.get("message", "bridge request failed") if isinstance(error, dict) else str(error)
                            pending[1].set_exception(RuntimeError(text))
                        else:
                            pending[1].set_result(result.get("result"))
        except (OSError, ValueError):
            logger.warning("agent-peers bridge connection closed")
        finally:
            self._fail_pending(process, _EXITED)
            # A broken stdout protocol must not leave an orphaned subprocess.
            try:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=0.5)
            except OSError:
                pass
            process.stdout.close()

    def _deliver(self):
        while not self._stopped:
            try:
                message = self._messages.get(timeout=0.1)
            except Empty:
                continue
            if self._stopped:
                break
            try:
                self.receive(message)
            except Exception:
                # Never log peer bodies, which may contain task data.
                logger.warning("agent-peers message could not be delivered", exc_info=False)

    def close(self):
        with self._lock:
            self._stopped = True
            process = self._process
            reader = self._reader
        self._fail_pending(None, "agent-peers plugin has been unloaded")
        if process:
            # Writers poll the stop flag every 100ms and release this lock.
            if self._write_lock.acquire(timeout=0.5):
                try:
                    process.stdin.close()
                finally:
                    self._write_lock.release()
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=0.5)
            except OSError:
                pass
        for worker in (reader, self._delivery):
            if worker and worker is not threading.current_thread():
                worker.join(timeout=0.5)
        while True:
            try:
                self._messages.get_nowait()
            except Empty:
                break
