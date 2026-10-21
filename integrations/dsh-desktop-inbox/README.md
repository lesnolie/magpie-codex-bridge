# Optional native DSH Desktop inbox (experimental)

This is an **opt-in Host plugin for DeepSeek Harness Desktop**, not a CLI
launcher and not a second ChatGPT/Magpie server. It uses only:

- the local Magpie MCP endpoint on `127.0.0.1:3425`;
- local-only `agent_register`, `agent_poll` and `agent_ack` tools;
- DSH's official Host `sessionController.prompt` service.

It NEVER accesses Desktop's private WebSocket/cookies, guesses a target DSH
Session, edits a project, or asserts that prompt admission proves execution.

## Prerequisites and deliberate limits

1. An installed Magpie Local Review bridge with `agent_register` supporting
   `resumeExisting` (this PR). The user enables peer messaging locally.
2. DSH Desktop has an active native Session and access to the installed
   `magpie-web-collab` Skill and `ego-browser` for replying to ChatGPT.
3. The user selects the exact **native DSH Session ID** (NOT the Magpie
   `agent_register` sessionId) and exact ChatGPT conversation URL locally.
   This adapter does not discover or select an arbitrary user's conversation.
4. Only one instance of this adapter should own each
   `harness+mode+project+chatUrl` binding. The bridge fails closed when
   multiple registrations match.

This package lives separately from the main Magpie plugin: simply updating
Magpie does **not** install it inside DSH Desktop. DSH installation and
configuration are user-initiated, after inspecting the experimental adapter.

## Installation / configuration (experimental, not yet Windows-verified)

DSH officially supports per-profile local plugins:

```powershell
dsh plugin --profile desktop add C:\path\to\magpie-codex-bridge\integrations\dsh-desktop-inbox
```

Configure the plugin in the Desktop profile with an explicit entry resembling:

```yaml
- id: magpie-dsh-desktop-inbox
  name: '@lesnolie/magpie-dsh-desktop-inbox'
  config:
    enabled: true
    project: 'DSH Desktop Test'
    chatUrl: 'https://chatgpt.com/c/EXACT-CONVERSATION-ID'
    nativeSessionId: 'EXACT-NATIVE-DSH-SESSION-ID'
    pollIntervalMs: 3000
```

Your DSH version's profile / plugin manager controls where its configuration
is persisted. The YAML above illustrates the entry's fields; do not paste it
into an unrelated settings file. Never copy browser authentication material.

Disabled or missing `enabled: true` means **no registration, no poll, no
prompt**. An incomplete/invalid enabled configuration fails activation.

## Delivery semantics and safety

1. Start: `agent_register(resumeExisting:true)`, preserving queued work
   across an ordinary Desktop restart when exactly one matching registration
   exists.
2. Every 3 seconds (configurable 1s–60s): call `agent_poll`.
3. For each message, call official `sessionController.prompt` for the
   **locally configured native DSH Session ID**, with a stable request ID
   derived from the Magpie message ID. Never execute the text in Node.
4. **Only after `prompt` returns `{accepted:true}`:** call `agent_ack`.
   Prompt acceptance means queued, not executed. A failed admission is never
   acknowledged; a failed ack is retried using the same native request ID.
5. The DSH Agent replies through its existing `magpie-web-collab` Skill and
   `ego-browser`. This adapter does not send a fake result to ChatGPT.

If `ctx.sessionController.prompt` is unavailable in the particular DSH
Desktop build, the plugin must remain disabled. No CLI fallback and no use
of Desktop internal browser-session credentials.

## Validation

```bash
node --test test/dsh-desktop-inbox.test.mjs test/peer-messages.test.mjs
```

**Real-machine acceptance still required:**
- verify the actual DSH profile loads this Host plugin;
- confirm the selected native Session receives exactly one prompt;
- verify message status moves queued → delivered → acked;
- verify an ego-browser reply arrives in the exact ChatGPT conversation;
- quit/restart Desktop and verify pending messages are not duplicated;
- revoke local authorization and confirm no further delivery.

This is a prototype, not yet a claim of unattended production support.
