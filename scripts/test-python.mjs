// Run the portable Python tests, failing with setup instructions when the interpreter or test deps are missing.
// Uses $AGENT_PEERS_PYTHON, else the repository .venv, else python3.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const venv = join(root, ".venv", "bin", "python");
const python = process.env.AGENT_PEERS_PYTHON || (existsSync(venv) ? venv : "python3");
const setup = [
  "Set up the Python test environment (Python 3.11-3.13), then retry:",
  `  python3 -m venv ${join(root, ".venv")}`,
  `  ${venv} -m pip install 'pytest>=8,<10' 'pytest-asyncio>=0.24,<2'`,
  "Or point AGENT_PEERS_PYTHON at an interpreter that already has pytest and pytest-asyncio.",
].join("\n");

const probe = spawnSync(python, ["-c", "import sys, pytest, pytest_asyncio; sys.exit(0 if sys.version_info >= (3, 11) else 3)"], { cwd: root, encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  const reason = probe.error ? `${python} could not be run (${probe.error.code ?? probe.error.message})`
    : probe.status === 3 ? `${python} is older than Python 3.11`
      : `${python} cannot import pytest and pytest-asyncio`;
  console.error(`test:python: ${reason}.\n${setup}`);
  process.exit(1);
}
const result = spawnSync(python, ["-m", "pytest", "-q"], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
