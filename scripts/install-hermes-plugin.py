#!/usr/bin/env python3
"""Compatibility launcher for the native Hermes plugin installer.

Delegates installation and enablement to Hermes without granting injection permission.
Use the native manager directly for updates, uninstall, and pinned revisions.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", default="https://github.com/ThomasMarcelis/agent-peers")
    parser.add_argument("--profile", help="Explicit Hermes profile selected by the native manager")
    parser.add_argument("--ref", help="Exact release commit to pin with the native manager")
    args = parser.parse_args(argv)
    hermes = shutil.which("hermes")
    if not hermes:
        parser.error("Hermes is not on PATH; install Hermes, then use its native plugins install command")
    command = [hermes]
    if args.profile:
        command += ["--profile", args.profile]
    command += ["plugins", "install", args.source, "--enable"]
    if args.ref:
        command += ["--ref", args.ref]
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
