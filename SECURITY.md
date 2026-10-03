# Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/ThomasMarcelis/agent-peers/security/advisories/new). Do not include credentials, private transcripts, or live inbox addresses in public issues.

The latest release receives security fixes. During 0.x development, fixes may require upgrading to the latest minor release.

## Trust boundary

agent-peers connects processes owned by the same local OS user. Socket permissions exclude other users; a malicious process already running as you can impersonate another peer. Names and reply addresses are not authenticated identities.

Peer messages are conversation input, not user approval. The receiving agent's permissions and inbound policy remain authoritative. Plugin injection can trigger a model turn and, in a gateway, a response to the original external chat. Enable it only for profiles where you want this behavior.

The package has no telemetry, central broker, transcript archive, or offline inbox. It reads agent session metadata and communicates over local sockets. Live test artifacts and optional diagnostic logs may contain local paths and conversation content; review them before sharing.
