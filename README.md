# Magpie Codex Bridge (Phase 1 prototype)

Experimental **Magpie tool plugin → local Codex app-server → existing Codex thread** bridge. Use Codex's own working directory and persisted session history; no project picker, coding agent, or custom compaction algorithm.

**Current status:** runnable prototype with mocked protocol integration tests. NOT yet validated with a real Windows Codex desktop session, Magpie installation, or the ChatGPT remote tunnel. It is not a production-ready remote execution service.

## What it does

- `threads`: list existing Codex threads from the same Codex home.
- `resume`: reattach by `threadId` without changing `cwd`, model, or permissions.
- `compact`: trigger Codex's native `thread/compact/start` and return immediately.
- `continue`: append a turn to that thread via `turn/start` (off by default).
- `status`: see native thread status and last tracked operation.

The Magpie MCP tool names will be prefixed with the plugin's short name (e.g. `magpie-codex-bridge_resume`). The names shown in Magpie are authoritative.

## Requirements

- Magpie release supporting OpenCode plugin `tool` hooks and `/mcp/magpie/tools`.
- Local authenticated Codex CLI with `codex app-server` on `PATH`.
- Both processes on the **same computer and user/CODEX_HOME** for shared threads.
- A separately configured **authenticated MCP tunnel** for ChatGPT Web. **Never forward Magpie's loopback MCP endpoint to the public Internet without authentication and access restrictions.**

## Install locally (Windows PowerShell)

```powershell
# Check prerequisite
codex --version
codex app-server --help
# From the folder containing package.json
magpie plugin add .
# Confirm tools in Magpie Settings > Plugins
npm test
```

If you cannot find the Codex CLI, install/update it using Codex's official instructions before attempting the test. The plugin does not install CoS. `CODEX_BRIDGE_COMMAND` can point to your existing Codex executable.

## Manual acceptance test: local compact → remote resume

1. In **local Codex**, open an **expendable test project** and make a new thread. Use only a harmless short prompt, then note the thread ID.
2. Use `threads` from Magpie to verify that the local thread appears with the expected working directory. If it does not, check `CODEX_HOME` and which Codex installation Magpie starts.
3. Stop editing that test thread in the desktop UI. In Magpie call `resume` with that thread ID.
4. Call `compact`. It returns before native compaction finishes; poll `status` until complete, including a `contextCompaction` event.
5. Restart Magpie's plugin host. `resume` again; verify the **same ID and original working directory**.
6. Explicitly set `CODEX_BRIDGE_ENABLE_CONTINUE=1` in the **trusted local Magpie process environment** and restart its plugin host. Call `continue` with a harmless test instruction. Poll `status` for completion. Verify the new turn appears in the original Codex thread and its context is preserved.
7. Reopen the original Codex UI and inspect the test thread. Do not send concurrent turns from desktop and bridge.

**Pass criteria:** thread ID unchanged, native compaction completed, remote app-server resumed same persisted thread, next turn executed in original `cwd`, no approval bypass. Log any client-ownership conflict as a failure.

## Known constraints / safety

- **No tunnel is set up by this repository.** Connecting ChatGPT Web requires your account's support for custom MCP tools plus a separate authenticated tunnel.
- A local `codex app-server` process is spawned from Magpie; it is not guaranteed to attach to the exact *live* in-memory process used by Codex Desktop. The test checks on-disk continuity. Do not concurrently write the same thread using two clients until conflict behavior is verified.
- Actions requiring interactive approval are **not auto-approved**: phase 1 replies with an error and may cause the affected turn to fail. Remote continue is off by default.
- The bridge does **not** customize Codex's model, workdir, sandbox or approval policy. It deliberately has no workspace selector.
- The plugin host may restart and lose in-memory progress events. Persisted Codex threads can be resumed, but an interrupted active turn is not guaranteed to survive a plugin-host restart.
- Magpie allows 55 seconds per tool; compact and continue return after the RPC acknowledges, not after the work finishes. Use `status` to poll.
- `status` only reports a short recent event list and bounded output preview, not full terminal logs.
- No Loop, multi-agent coordinator, browser automation, Intelligent UI modifications, or desktop-control reproduction in this phase.

## Technical design

`Magpie tool → Codex app-server stdio JSON-RPC → existing local Codex thread`. The bridge uses the official `initialize` / `initialized` handshake and `thread/list`, `thread/resume`, `thread/compact/start`, `thread/read`, `turn/start`, plus notification events. No file operations are implemented in the bridge: Codex itself owns them.

Reference documentation:
- [Magpie plugin tools](https://usemagpie.ai/docs/plugins#tools-for-every-agent)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)

## Test and contribute

```sh
npm test
npm run check
```

Tests use a subprocess fake of Codex's documented JSON-RPC protocol. They prove bridge request/response, native-compaction event handling, restart/resume identity and basic concurrency rejection, **not compatibility with installed Codex Desktop**. See [`docs/acceptance.md`](docs/acceptance.md) for the real-system matrix.

License: MIT. Not affiliated with Magpie, CoS, or OpenAI.

## Publish as a new public GitHub repository

The local archive contains source, **not a remotely created GitHub repository**. To create and push a new public repository from Windows after installing and authenticating [GitHub CLI](https://cli.github.com/):

```powershell
# Run in the unzipped source folder:
.\scripts\publish.ps1
```

This script uses `gh repo create --public --source . --remote origin --push`, with no force push. It does not change any existing GitHub repository. If you prefer preserving the included development history, use the separately supplied `.git.bundle` to clone locally before pushing.
