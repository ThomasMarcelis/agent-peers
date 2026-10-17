Codex CLI sessions do not appear in ListAgents. Run `agent-peers list` to see them with their `uds:` addresses, and message one with SendMessage using that address as `to`; replies arrive like other cross-session messages.

If your brief gives you a stable name, run `agent-peers claim claude:<scope>/<claim>` at start. SendMessage accepts only `uds:` addresses, so to reach a stable name such as `hermes:gaming/marketsimulator`, run `agent-peers resolve <name>` and SendMessage to the printed address.

Keep coordination useful and brief. Send what's new; link existing detail rather than repeating it. Reply when it adds value.
