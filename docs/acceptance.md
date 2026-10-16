# Phase 1 acceptance and evidence

## Already automatable without account access

- [x] JSON-RPC initialization over stdio
- [x] Enumerate persisted threads
- [x] Resume thread by immutable ID
- [x] Begin native compaction and observe completion
- [x] Fresh app-server instance resumes same test thread ID after compaction
- [x] Continue a new turn without providing or overwriting `cwd`
- [x] Reject duplicate bridge-initiated work on one thread
- [x] Reject unknown thread IDs

## Requires owner's Windows setup and permission

- [ ] Verify local Codex Desktop thread is listed by independent app-server process
- [ ] Verify existing session compacts in native local Codex
- [ ] Verify bridge resumes same Codex Desktop thread after compaction
- [ ] Verify Codex Desktop and bridge do not race when both are open
- [ ] Verify no change to approval policy, sandbox, model or cwd
- [ ] Verify plugin tool names and execution work on installed Magpie version
- [ ] Verify authenticated MCP tunnel exposes only intended Magpie tools to ChatGPT Web
- [ ] Verify ChatGPT remote continue and task result are visible without changing ChatGPT-native UI

## Later / deliberately excluded

Loop, browser integration, Codex desktop control, Intelligent UI regression testing, ChatGPT Web session synchronization, automatic reconnect and unattended operation.
