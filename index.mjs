import { CodexAppServer } from './src/app-server.mjs';

// Magpie's supported OpenCode-style `tool` hook; JSON Schema property definitions
// avoid adding a runtime dependency for the very first compatibility probe.
let sharedClient;
const client = () => (sharedClient ||= new CodexAppServer());
const json = (value) => JSON.stringify(value, null, 2);
const safe = (operation) => async (args) => {
  try { return json({ ok: true, result: await operation(args || {}) }); }
  catch (err) { return json({ ok: false, error: err.message }); }
};
const threadArg = { type: 'string', minLength: 1, description: 'Existing Codex thread ID, not a filesystem directory.' };

export const MagpieCodexBridge = async () => ({
  tool: {
    threads: {
      description: 'List existing Codex threads saved on this computer. Does not create projects or change folders.',
      args: { limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum number of recent threads.' } },
      execute: safe(({ limit = 10 }) => client().listThreads(limit)),
    },
    resume: {
      description: 'Attach to an existing local Codex thread by its ID, preserving Codex cwd, model and permissions.',
      args: { threadId: threadArg },
      execute: safe(({ threadId }) => client().resume(threadId)),
    },
    compact: {
      description: 'Start native Codex thread compaction asynchronously. Does not summarize independently; use status to check.',
      args: { threadId: threadArg },
      execute: safe(({ threadId }) => client().compact(threadId)),
    },
    continue: {
      description: 'Submit a new turn to an existing Codex thread with unchanged working directory. Opt-in disabled by default. Never use to bypass approvals.',
      args: { threadId: threadArg, message: { type: 'string', minLength: 1, maxLength: 12000, description: 'Instructions to send to the resumed Codex thread.' } },
      execute: safe(({ threadId, message }) => {
        if (process.env.CODEX_BRIDGE_ENABLE_CONTINUE !== '1') throw new Error('Continue disabled. Set CODEX_BRIDGE_ENABLE_CONTINUE=1 on the trusted local Magpie host only after testing read-only calls.');
        return client().continueThread(threadId, message);
      }),
    },
    status: {
      description: 'Check native thread status plus this bridge process’s most recent operation. Status can be unknown after host restart.',
      args: { threadId: threadArg },
      execute: safe(({ threadId }) => client().status(threadId)),
    },
  },
});
