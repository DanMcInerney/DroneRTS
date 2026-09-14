# Native runtime evidence

Implemented and exercised 13 September 2026 with Codex **0.144.0**, confirmed from the started thread's `cliVersion`. Runtime version is included in status and audit events. The only inference model permitted is **gpt-5.6-luna**, reasoning **xhigh**, verified against `model/list` before starting a turn. Each custom drone config also fixes that model and effort; the native spawn audit reports both.

`CodexFleetRuntime` uses the agreed constructor and `start()` / `stop()` interface. The server adapter supplies the game behavior through `toolHandler`; the runtime owns model verification, the Codex app-server process, native child configuration, per-role MCP connections, bootstrap policy, and cleanup.

## Exercised checks

- `scripts/runtime-preflight.ts`: no inference. App-server configuration confirms only the fleet MCP endpoint, and a direct `mcpServer/tool/call` reaches the bridge and returns its actual result.
- `scripts/runtime-spike.ts`: bounded native-agent integration test with synthetic images, **not a game playtest**. The parent launches three native children. Each child waits, receives a different actual image content block, then sends the correct observed color through its own radio tool. Latest evidence is `runtime-spike-evidence.json`.
- The successful test includes all three parent `PreToolUse` bootstrap rewrites and parent relay hook execution. All children report the requested Luna/xhigh configuration. Stop interrupts the session tree, closes MCP requests, terminates the process tree, and removes the private run directory.
- `tests/runtime.test.ts`: malicious spawn arguments are replaced by a fixed prompt/configuration, duplicate spawns and native peer messaging are denied, normal fleet tool calls pass, and Stop during startup cancels before inference without leaving private run state.

## Installed-version details

Codex 0.144 requires `agents.max_threads` and explicit `agents.<role>.config_file`. A disabled inherited MCP entry still needs its transport URL in the custom-agent file. `default_tools_approval_mode = "approve"` is set only on this simulator's own MCP servers, because the user has already authorized gameplay.

The CLI's global hook-trust option alone did not activate hooks through app-server. The app-server-specific `thread/start` configuration override `bypass_hook_trust: true` activates our generated, vetted parent hook. A normal allowed call must return an empty hook result in this installed build; `permissionDecision: "allow"` works when accompanied by replacement `updatedInput` for the bootstrap.

## Boundaries and limitations

The parent hook replaces the entire spawn argument object with the fixed child type, bootstrap message, Luna model, xhigh effort, and clean-context setting. It permits each of the three roles once and denies other local tools. The parent can access only `forward_next_instruction` on its MCP connection. Three native children are the configured maximum, and child delegation is disabled.

Child hook execution did not appear in the installed runtime event stream, so it is **not claimed as an enforcement layer**. Each child instead receives only its own role-scoped fleet MCP endpoint; shell, child delegation, web, apps, plugins, and image generation are disabled, with a read-only sandbox and an empty private working directory. Sensor identities are bound to separate random-capability MCP endpoints, not model-supplied drone IDs. Mission decisions and peer speech happen only in the agents' game tool calls.

Temporary per-run Codex state reuses the locally signed-in account by copying its authentication file into the private run directory; the copy is removed on Stop. Global Codex configuration is unchanged. An abrupt OS/process termination can prevent normal cleanup; this is a local-development PoC rather than a hardened multi-user service.

Native children are kept in their event loops for the mission. Unexpected reported turn completion stops the fleet and asks for Reset. Persistent actor resumption after a finished native child is not implemented.

Early integration probes exposed malformed custom role configuration and missing MCP auto-approval. They were stopped and fixed; the runtime now stops bootstrap if it consumes 40,000 cumulative reported tokens without any game-tool call, fails after repeated policy denials, and stops on failed policy hooks. Reported usage includes repeated context tokens and should not be interpreted as a price or exclusively generated text.
