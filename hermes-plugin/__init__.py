"""Compatibility entrypoint for existing checkout symlinks; install the repo root."""

import importlib.util
from pathlib import Path
import sys

_package = Path(__file__).resolve().parent.parent / "agent_peers"
_name = __name__ + "._implementation"
_spec = importlib.util.spec_from_file_location(_name, _package / "__init__.py",
                                             submodule_search_locations=[str(_package)])
_module = importlib.util.module_from_spec(_spec)
sys.modules[_name] = _module
_spec.loader.exec_module(_module)
BridgeClient, PeerTools, register = _module.BridgeClient, _module.PeerTools, _module.register
__all__ = ["BridgeClient", "PeerTools", "register"]
