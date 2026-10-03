# Finish agent-peers setup

Automatic Hermes replies require the host revision documented in [compatibility](https://github.com/ThomasMarcelis/agent-peers/blob/main/docs/compatibility.md). Stock Hermes supports discovery only.

1. Install Node.js 22+ and accept the plugin's Node dependency installation. If your installer does not offer it, run `npm ci --omit=dev --ignore-scripts` in the plugin directory printed by the installer.
2. For the selected profile, explicitly enable automatic conversation input: `hermes config set plugins.entries.agent-peers.allow_gateway_injection true`. With a named profile, add `--profile NAME` after `hermes`.
3. Enable the `agent-peers` toolset for the platforms where you want it, if your saved selection excludes it. Open a fresh conversation after the host loads the plugin.

Call `list_peers`, then `send_peer` with a listed target. Hermes stays hidden; replies return to the conversation that sent the request. The injection grant permits model turns and, in messaging gateways, replies to that conversation's external chat/thread.

No profile permissions are changed automatically. The standalone Codex/Claude setup is independent; see the [quick start](https://github.com/ThomasMarcelis/agent-peers#install).
