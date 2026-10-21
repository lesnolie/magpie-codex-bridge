import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerMessages } from '../src/peer-messages.mjs';
import { createPeerWake, sessionLiveness, wakePrompt, WAKE_MODES } from '../src/peer-wake.mjs';

const CHAT = 'https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
const P = 'Project';

function mailbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-wake-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return { directory, peers: createPeerMessages({ directory }) };
}

/** Record what each launcher was asked to do without starting a process. */
function launchers() {
  const calls = [];
  const harnessRunner = {
    launch(args) {
      calls.push({ kind: 'cli', args });
      return JSON.stringify({ harness: args.harness, mode: 'cli', state: 'running',
        taskId: 'cli-task-1', processCompleted: false, taskOutcomeVerified: false });
    },
  };
  const codex = {
    submit(args) {
      calls.push({ kind: 'appserver', args });
      return JSON.stringify({ id: 'codex-task-1', state: 'running' });
    },
  };
  return { calls, harnessRunner, codex };
}

test('an already-running harness cannot be doubled by a stale-session wake', t => {
  // A harness can stay alive without polling (long tool call, blocked browser).
  // sessionLiveness then reports "stopped", but the underlying runners refuse a
  // second concurrent task. The wake must fail closed and keep the command
  // queued rather than starting a duplicate.
  const { peers } = mailbox(t);
  const busyRunner = {
    launch() { throw Error('Another agent CLI task is active; finish or cancel it first'); },
  };
  const busyCodex = {
    submit() { throw Error('A Codex task is already running'); },
  };
  const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers,
    harnessRunner: busyRunner, codex: busyCodex });

  for (const harness of ['claude', 'dsh', 'codex']) {
    const receipt = wake.wake({ harness, project: P, chatUrl: CHAT,
      taskId: 'busy-' + harness, messageId: 'busy-msg-' + harness,
      command: 'REQUEST', message: 'Do more work' });
    assert.equal(receipt.state, 'wake-failed', harness + ' must not report a launch');
    assert.equal(receipt.queuedOnly, true);
    assert.equal(receipt.confirmedExecution, false);
    assert.match(receipt.reason, /already running|already active|task is active/);

    // The command is still there for the original harness to pick up.
    const polled = JSON.parse(peers.poll({ sessionId: receipt.sessionId, chatUrl: CHAT }));
    assert.equal(polled.messages.length, 1, harness + ' keeps the queued command');
    assert.equal(polled.messages[0].message, 'Do more work');
  }
});

test('the wake prompt states the mailbox mode so the agent can actually adopt it', t => {
  // Regression: the mode is part of the mailbox identity. Codex wakes provision
  // with mode=app-server. An adoption call without that exact mode matches no
  // session, so agent_register would silently create a SECOND one and leave the
  // waking command unread in the first.
  for (const [harness, mode] of [['codex', 'app-server'], ['claude', 'cli'], ['dsh', 'cli']]) {
    const { peers } = mailbox(t);
    const { harnessRunner, codex } = launchers();
    const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers, harnessRunner, codex });
    const receipt = wake.wake({ harness, project: P, chatUrl: CHAT,
      taskId: 'adopt-' + harness, messageId: 'adopt-msg-' + harness,
      command: 'REQUEST', message: 'Work' });
    assert.equal(receipt.mode, mode);

    // The prompt the agent receives must name the mode EXPLICITLY.
    const prompt = wakePrompt({ command: 'REQUEST', taskId: 'adopt-' + harness,
      message: 'Work', harness, project: P, chatUrl: CHAT,
      sessionId: receipt.sessionId, messageId: 'adopt-msg-' + harness, mode });
    assert.match(prompt, new RegExp('PEER_MAILBOX_MODE: ' + mode));
    assert.ok(prompt.includes('mode: "' + mode + '"'), 'adoption call states the literal mode');

    // Follow that instruction exactly: it must resolve to the SAME session and
    // reveal the queued command.
    const adopted = JSON.parse(peers.register({ harness, project: P, chatUrl: CHAT,
      mode, resumeExisting: true }));
    assert.equal(adopted.sessionId, receipt.sessionId,
      harness + ' must adopt the provisioned session, not create a new one');
    const polled = JSON.parse(peers.poll({ sessionId: adopted.sessionId, chatUrl: CHAT }));
    assert.equal(polled.messages.length, 1);
    assert.equal(polled.messages[0].message, 'Work');
  }
});

test('a wake without a mode is refused instead of producing unadoptable instructions', () => {
  assert.throws(() => wakePrompt({ command: 'REQUEST', taskId: 't', message: 'x',
    harness: 'codex', project: P, chatUrl: CHAT, sessionId: 's', messageId: 'm' }),
    /must state its mailbox mode/);
});

test('only the three user-selected harnesses can be woken', () => {
  assert.deepEqual(Object.keys(WAKE_MODES).sort(), ['claude', 'codex', 'dsh']);
  assert.equal(WAKE_MODES.codex, 'app-server');
  assert.equal(WAKE_MODES.claude, 'cli');
  assert.equal(WAKE_MODES.dsh, 'cli');
});

test('a missing registration is provisioned and the named harness is started once', t => {
  const { peers } = mailbox(t);
  const { calls, harnessRunner, codex } = launchers();
  const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers, harnessRunner, codex });
  const receipt = wake.wake({ harness: 'Claude', project: P, chatUrl: CHAT,
    taskId: 'task-1', messageId: 'msg-1', command: 'REQUEST', message: 'Run the tests' });

  assert.equal(receipt.harness, 'claude');
  assert.equal(receipt.mode, 'cli');
  assert.equal(receipt.state, 'running');
  assert.equal(receipt.confirmedExecution, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'cli');

  // The command is queued in the very session the new process is told to adopt.
  const polled = JSON.parse(peers.poll({ sessionId: receipt.sessionId, chatUrl: CHAT }));
  assert.equal(polled.messages.length, 1);
  assert.equal(polled.messages[0].message, 'Run the tests');
  assert.equal(calls[0].args.peerMailbox.sessionId, receipt.sessionId);
  assert.match(calls[0].args.prompt, /PEER_MAILBOX_SESSION_ID: /);
});

test('waking Codex uses headless app-server, not a Desktop composer someone must submit', t => {
  const { peers } = mailbox(t);
  const { calls, harnessRunner, codex } = launchers();
  const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers, harnessRunner, codex });
  const receipt = wake.wake({ harness: 'codex', project: P, chatUrl: CHAT,
    taskId: 'task-c', messageId: 'msg-c', command: 'REQUEST', message: 'Fix the bug' });
  assert.equal(receipt.mode, 'app-server');
  assert.equal(receipt.taskId, 'codex-task-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'appserver');
  assert.equal(calls[0].args.chatUrl, CHAT);
});

test('a repeated message ID reuses the wake instead of starting a second process', t => {
  const { peers } = mailbox(t);
  const { calls, harnessRunner, codex } = launchers();
  const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers, harnessRunner, codex });
  const args = { harness: 'claude', project: P, chatUrl: CHAT,
    taskId: 'task-2', messageId: 'msg-2', command: 'REQUEST', message: 'Do work' };
  const first = wake.wake(args);
  const second = wake.wake(args);
  assert.equal(calls.length, 1);
  assert.equal(second.reused, true);
  assert.equal(second.sessionId, first.sessionId);
});

test('local permission is required before any wake starts a process', t => {
  const { peers } = mailbox(t);
  const { calls, harnessRunner, codex } = launchers();
  const wake = createPeerWake({ options: {}, peers, harnessRunner, codex });
  assert.throws(() => wake.wake({ harness: 'claude', project: P, chatUrl: CHAT,
    taskId: 't', messageId: 'm', command: 'REQUEST', message: 'x' }), /disabled in local Magpie settings/);
  assert.equal(calls.length, 0);
});

test('unsupported harness and external chat URLs are refused without substitution', t => {
  const { peers } = mailbox(t);
  const { calls, harnessRunner, codex } = launchers();
  const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers, harnessRunner, codex });
  assert.throws(() => wake.wake({ harness: 'opencode', project: P, chatUrl: CHAT,
    taskId: 't', messageId: 'm', command: 'REQUEST', message: 'x' }), /No wake adapter/);
  assert.throws(() => wake.wake({ harness: 'claude', project: P,
    chatUrl: 'https://evil.test/c/1234567890', taskId: 't', messageId: 'm',
    command: 'REQUEST', message: 'x' }), /chatgpt\.com/);
  assert.equal(calls.length, 0);
});

test('a failed launch still leaves the command queued for a later manual start', t => {
  const { peers } = mailbox(t);
  const failing = { launch() { throw Error('Selected harness has no supported CLI launcher'); } };
  const wake = createPeerWake({ options: { agentLaunchEnabled: true }, peers,
    harnessRunner: failing, codex: {} });
  const receipt = wake.wake({ harness: 'claude', project: P, chatUrl: CHAT,
    taskId: 'task-3', messageId: 'msg-3', command: 'REQUEST', message: 'Queued anyway' });
  assert.equal(receipt.state, 'wake-failed');
  assert.equal(receipt.queuedOnly, true);
  assert.equal(receipt.confirmedExecution, false);
  const polled = JSON.parse(peers.poll({ sessionId: receipt.sessionId, chatUrl: CHAT }));
  assert.equal(polled.messages.length, 1);
  assert.equal(polled.messages[0].message, 'Queued anyway');
});

test('liveness separates a polling session from a stopped or starting one', () => {
  const now = Date.parse('2026-10-21T04:00:00Z');
  assert.equal(sessionLiveness(null, now), 'unknown');
  assert.equal(sessionLiveness({ registeredAt: new Date(now - 600_000).toISOString(),
    lastPollAt: new Date(now - 5_000).toISOString() }, now), 'live');
  assert.equal(sessionLiveness({ registeredAt: new Date(now - 600_000).toISOString(),
    lastPollAt: new Date(now - 600_000).toISOString() }, now), 'stopped');
  // Provisioned for a wake that has not polled yet: no duplicate launch.
  assert.equal(sessionLiveness({ registeredAt: new Date(now - 30_000).toISOString(),
    lastPollAt: null }, now), 'starting');
  assert.equal(sessionLiveness({ registeredAt: new Date(now - 3_600_000).toISOString(),
    lastPollAt: null }, now), 'stopped');
});

test('the wake prompt tells the harness to adopt one session and not repeat itself', () => {
  const prompt = wakePrompt({ command: 'REQUEST', taskId: 'task-9', message: 'Refactor the loader',
    harness: 'claude', project: P, chatUrl: CHAT, sessionId: 'session-9', messageId: 'msg-9',
    mode: 'cli' });
  assert.match(prompt, /^\[MAGPIE\] REQUEST\nTASK: task-9\n/);
  assert.match(prompt, /Refactor the loader/);
  assert.match(prompt, /PEER_MAILBOX_SESSION_ID: session-9/);
  assert.match(prompt, /PEER_MAILBOX_MODE: cli/);
  assert.match(prompt, /PEER_MAILBOX_MESSAGE_ID: msg-9/);
  assert.match(prompt, /instead of creating a second session/);
  assert.match(prompt, /Do not execute the same command twice/);
  assert.match(prompt, /carry out in-scope work directly/);
  assert.match(prompt, /Do not ask for per-step/);
});
