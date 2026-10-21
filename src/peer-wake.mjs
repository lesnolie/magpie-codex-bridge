/**
 * ChatGPT Web -> a *stopped* harness.
 *
 * The peer mailbox alone can only reach a harness that is already running and
 * polling. This module closes that gap for the three harnesses the user selects
 * explicitly (codex, claude, dsh): when no live session is registered, the
 * command is queued first, then the named harness is started once and told to
 * adopt that exact mailbox session.
 *
 * Guarantees kept from the rest of the plugin:
 *  - only locally allowlisted projects;
 *  - only the harness the user named, never a substitute;
 *  - never an executable path or shell fragment from the remote caller;
 *  - a launch is a dispatch receipt, never proof of execution.
 *
 * A wake never happens unless the local `agentLaunchEnabled` option is on.
 */
import { normalizeHarness, normalizePeerChatUrl } from './peer-messages.mjs';

/** How long a registration may stay silent before it counts as stopped. */
const LIVE_WINDOW_MS = 120_000;
/** Grace for a session provisioned by a wake that has not polled yet. */
const STARTUP_GRACE_MS = 5 * 60_000;

/** Harnesses this build can actually start, and the mode each wake uses. */
export const WAKE_MODES = Object.freeze({ codex: 'app-server', claude: 'cli', dsh: 'cli' });
const MAX_WAKE_PROMPT = 12_000;

function parseSession(reply) {
  const value = typeof reply === 'string' ? JSON.parse(reply) : reply;
  if (!value || typeof value.sessionId !== 'string' || !value.sessionId)
    throw Error('Peer mailbox returned no sessionId');
  return value;
}

/**
 * Decide whether an existing registration can still receive a command.
 * `lastPollAt` is the only real signal; registration alone proves nothing.
 */
export function sessionLiveness(session, now = Date.now()) {
  if (!session || typeof session.registeredAt !== 'string') return 'unknown';
  const lastPoll = typeof session.lastPollAt === 'string' ? Date.parse(session.lastPollAt) : NaN;
  if (Number.isFinite(lastPoll)) {
    return now - lastPoll <= LIVE_WINDOW_MS ? 'live' : 'stopped';
  }
  const registered = Date.parse(session.registeredAt);
  if (!Number.isFinite(registered)) return 'unknown';
  // Provisioned for a wake that has not polled yet: give it time to start
  // rather than launching a second process on every retry.
  return now - registered <= STARTUP_GRACE_MS ? 'starting' : 'stopped';
}

export function wakePrompt({ command, taskId, message, harness, project, chatUrl, sessionId, messageId }) {
  if (typeof message !== 'string' || !message.trim()) throw Error('A wake needs the actual command text');
  if (message.length > MAX_WAKE_PROMPT) throw Error('Wake command is too long');
  return [
    '[MAGPIE] ' + command,
    'TASK: ' + taskId,
    '',
    message.trim(),
    '',
    '--- PEER COLLABORATION ---',
    'You were started by ChatGPT Web because no live ' + harness + ' session was registered.',
    'HARNESS: ' + harness,
    'PROJECT: ' + project,
    'CHAT_URL: ' + chatUrl,
    'PEER_MAILBOX_SESSION_ID: ' + sessionId,
    'PEER_MAILBOX_MESSAGE_ID: ' + messageId,
    '',
    'The command above is ALSO queued in that exact Magpie mailbox message.',
    '1. Adopt the session with one agent_register({harness, project, chatUrl, mode, resumeExisting:true})',
    '   call and confirm it returns PEER_MAILBOX_SESSION_ID above. Never create a second session.',
    '2. agent_poll it. If you see PEER_MAILBOX_MESSAGE_ID, agent_ack it after you have actually',
    '   processed the work. Do not execute the same command twice.',
    '3. Reply with real results in this exact ChatGPT conversation, not in another chat.',
    'You and ChatGPT Web are peers: carry out in-scope work directly, and include your own',
    'REQUEST/RESULT when the next step belongs to the other side. Do not ask for per-step',
    'confirmation, and do not run a HELLO/ACK ceremony.',
    'Obey your native local permission policy and stay inside the project above.',
    'If ego-browser or the Skill is unavailable, say so plainly instead of claiming success.',
  ].join('\n');
}

export function createPeerWake({ options = {}, peers, harnessRunner, codex } = {}) {
  if (!peers || typeof peers.provision !== 'function') throw Error('Peer mailbox is required');
  const wakes = new Map();

  const key = args => [args.harness, args.project, args.chatUrl, args.messageId].join('|');

  /** Find the single registration for this harness/project/chat, if any. */
  function existingSession({ harness, project, chatUrl }) {
    const listed = JSON.parse(peers.list()).sessions;
    const matching = listed.filter(s => s.harness === harness && s.chatUrl === chatUrl &&
      (!project || s.project === project));
    if (matching.length > 1) return { ambiguous: true, count: matching.length };
    return { session: matching[0] || null };
  }

  return {
    /**
     * Queue the command, start the named harness once, and return a receipt.
     * Repeating the same message ID returns the original receipt.
     */
    wake({ harness, project, chatUrl, taskId, messageId, command, message } = {}) {
      if (options.agentLaunchEnabled !== true)
        throw Error('Harness auto-wake is disabled in local Magpie settings');
      const selected = normalizeHarness(harness);
      const mode = WAKE_MODES[selected];
      if (!mode)
        throw Error('No wake adapter for the requested harness; supported: ' +
          Object.keys(WAKE_MODES).join(', '));
      const url = normalizePeerChatUrl(chatUrl);
      if (typeof project !== 'string' || !project.trim())
        throw Error('An exact locally authorized project is required to wake a harness');

      const receiptKey = key({ harness: selected, project, chatUrl: url, messageId });
      const previous = wakes.get(receiptKey);
      if (previous) return { ...previous, reused: true,
        note: 'This wake was already dispatched; no second process started.' };

      // Queue first so the harness finds the command the moment it polls.
      const session = parseSession(peers.provision({ harness: selected, project, chatUrl: url, mode }));
      const queued = JSON.parse(peers.send({ sessionId: session.sessionId, chatUrl: url,
        taskId, messageId, command, message }));

      const prompt = wakePrompt({ command, taskId, message, harness: selected,
        project, chatUrl: url, sessionId: session.sessionId, messageId });

      let launch;
      try {
        if (selected === 'codex') {
          // Headless app-server: a wake must not depend on someone pressing Send.
          launch = JSON.parse(codex.submit({ project, prompt, chatUrl: url }));
        } else {
          launch = JSON.parse(harnessRunner.launch({ harness: selected, project,
            prompt, chatUrl: url, peerMailbox: { sessionId: session.sessionId, mode } }));
        }
      } catch (error) {
        // The command stays queued so a manually started harness still gets it.
        const failed = { harness: selected, mode, project, state: 'wake-failed',
          sessionId: session.sessionId, taskId: null, messageId, queued,
          reason: String(error?.message || error).slice(0, 300),
          queuedOnly: true, confirmedExecution: false,
          note: 'The command is queued in the mailbox but no harness was started.' };
        wakes.set(receiptKey, failed);
        return failed;
      }

      const result = { harness: selected, mode, project,
        state: launch.state || 'dispatched',
        sessionId: session.sessionId,
        taskId: launch.taskId || launch.id || null,
        messageId,
        queued,
        reused: false,
        confirmedExecution: false,
        queuedOnly: false,
        note: 'Harness process start is not proof it read the command; check agent_message_status.' };
      wakes.set(receiptKey, result);
      return result;
    },

    /** Read the last wake receipt for a specific queued command, if any. */
    receipt({ harness, project, chatUrl, messageId } = {}) {
      try {
        const url = normalizePeerChatUrl(chatUrl);
        const found = wakes.get(key({ harness: normalizeHarness(harness), project, chatUrl: url, messageId }));
        return found || null;
      } catch { return null; }
    },

    existingSession,
    liveness: session => sessionLiveness(session),
  };
}
