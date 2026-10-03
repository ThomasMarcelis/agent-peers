#!/usr/bin/env python3
"""Install the local plugin into selected Hermes homes, preserving other settings."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil

import yaml


def install(home: Path, source: Path, command: list[str]) -> dict:
    from hermes_cli.config import atomic_config_write
    from hermes_cli.toolset_validation import parse_platform_toolsets_value

    home = home.resolve()
    config_path = home / "config.yaml"
    if not config_path.is_file():
        raise ValueError(f"No Hermes configuration at {config_path}")
    config = yaml.safe_load(config_path.read_text()) or {}
    if not isinstance(config, dict):
        raise ValueError(f"Configuration is not a mapping: {config_path}")
    target = home / "plugins" / "agent-peers"
    if target.exists() or target.is_symlink():
        if not target.is_symlink() or target.resolve() != source.resolve():
            raise ValueError(f"Existing plugin was not installed from this checkout: {target}")

    plugins = config.setdefault("plugins", {})
    enabled = plugins.setdefault("enabled", [])
    if "agent-peers" not in enabled:
        enabled.append("agent-peers")
    if isinstance(plugins.get("disabled"), list):
        plugins["disabled"] = [name for name in plugins["disabled"] if name != "agent-peers"]
    entry = plugins.setdefault("entries", {}).setdefault("agent-peers", {})
    entry["allow_gateway_injection"] = True
    entry.setdefault("settings", {})["bridge_command"] = command
    # Missing platform selections retain their native defaults. Newly installed plugin
    # toolsets are enabled automatically; saved selections need an explicit addition.
    for platform, raw in (config.get("platform_toolsets") or {}).items():
        selection = parse_platform_toolsets_value(raw)
        if selection is None:
            raise ValueError(f"Invalid platform tool selection for {platform} in {config_path}")
        if "agent-peers" not in selection:
            config["platform_toolsets"][platform] = [*selection, "agent-peers"]
    agent = config.get("agent") or {}
    disabled = agent.get("disabled_toolsets")
    if isinstance(disabled, list):
        agent["disabled_toolsets"] = [name for name in disabled if name != "agent-peers"]

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = config_path.with_name(f"config.yaml.agent-peers-backup-{stamp}")
    shutil.copy2(config_path, backup)
    target.parent.mkdir(parents=True, exist_ok=True)
    created = not target.is_symlink()
    if created:
        target.symlink_to(source.resolve(), target_is_directory=True)
    try:
        atomic_config_write(config_path, config)
    except Exception:
        if created:
            target.unlink()
        raise
    reread = yaml.safe_load(config_path.read_text())
    assert reread["plugins"]["entries"]["agent-peers"] == entry
    return {"home": str(home), "plugin": str(target), "backup": str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, action="append", required=True,
                        help="Profile home to configure; repeat for multiple profiles")
    parser.add_argument("--node", required=True, type=Path, help="Absolute Node.js executable")
    args = parser.parse_args()
    if not args.node.is_absolute() or not args.node.is_file():
        parser.error("--node must be an existing absolute executable path")
    root = Path(__file__).resolve().parent.parent
    command = [str(args.node), str(root / "bin" / "agent-peers.mjs"), "hermes-bridge"]
    import json
    for home in args.home:
        print(json.dumps(install(home, root / "hermes-plugin", command)))


if __name__ == "__main__":
    main()
