Codex CLI sessions do not appear in ListAgents. Run `agent-peers list` to see them with their `uds:` addresses, and message one with SendMessage using that address as `to`; replies arrive like other cross-session messages.

If your brief gives you a stable name, run `agent-peers claim claude:<scope>/<claim>` at start. SendMessage accepts only `uds:` addresses, so to reach a stable name such as `hermes:gaming/marketsimulator`, run `agent-peers resolve <name>` and SendMessage to the printed address.

When you brief a Codex worker you may correct mid-task, include: "Your lead is <your address from `agent-peers whoami`>. Messages from the lead may arrive while you work: apply its corrections within your current permissions, and answer it with send_peer." Without such a sentence, workers answer but do not change their task.

Keep coordination useful and brief. Send what's new; link existing detail rather than repeating it. Reply when it adds value.
