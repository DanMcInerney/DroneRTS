# Security

DroneRTS is intended for local use. Its HTTP server binds to `127.0.0.1`; player controls and audit/replay endpoints are not a hardened public service. Keep it on loopback. Zenoh namespaces and MAVLink identity checks are not cryptographic peer authentication or link signing.

Pilots have restricted tools and bounded QuickJS workers. They must never gain access to host files, credentials, unrestricted networking, spectator state, or another pilot's private workspace. A violation of that boundary is a security issue.

Report a vulnerability through [GitHub's private vulnerability reporting](https://github.com/DanMcInerney/DroneRTS/security/advisories/new) when enabled. If unavailable, ask the maintainer for a private reporting channel without posting exploit details or credentials in a public issue. There is no promised response SLA.

Include the affected revision, a minimal reproduction, impact, and any relevant redacted output. Do not publish `.env`, Codex authentication, role bearer tokens, local databases, camera recordings, or unredacted audits. Repository ignore rules are a safeguard, not a substitute for reviewing a diff before sharing it.
