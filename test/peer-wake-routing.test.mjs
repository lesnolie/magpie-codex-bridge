import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerMessages } from '../src/peer-messages.mjs';

/**
 * The tool handler in index.mjs cannot spawn a real harness in CI, so this test
 * exercises the exact composition it uses: mailbox provisioning + liveness
 * gate + one-shot wake, against a stubbed launcher.
 */
const CHAT = 'https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';

function mailbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-wake-e2e-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return createPeerMessages({ directory });
}

/** Mirror of the agent_message_send handler's wake decision. */
function send(peers, { sessionLiveness, wake }, args) {
  const canWake = args.wake !== false;
  const listed = JSON.parse(peers.list()).sessions;
  const matching = listed.filter(s => s.harness === args.harness && s.chatUrl === args.chatUrl &&
    (!args.project || s.project === args.project));
  if (matching.length > 1) return JSON.parse(peers.send(args));
  const state = sessionLiveness(matching[0] || null);
  if (state === 'live' || !canWake) return JSON.parse(peers.send(args));
  const receipt = wake(args);
  return { ...receipt.queued, sessionId: receipt.sessionId, wake: receipt };
}

test('a live polling session receives the command without starting a process', t => {
  const peers = mailbox(t);
  const registered = JSON.parse(peers.register({ harness: 'claude', mode: 'cli',
    project: 'P', chatUrl: CHAT }));
  peers.poll({ sessionId: registered.sessionId, chatUrl: CHAT });
  let wakes = 0;
  const result = send(peers, {
    sessionLiveness: () => 'live',
    wake: () => { wakes++; throw Error('must not wake a live session'); },
  }, { harness: 'claude', project: 'P', chatUrl: CHAT, taskId: 't1',
    messageId: 'm1', command: 'REQUEST', message: 'Continue the work' });
  assert.equal(wakes, 0);
  assert.equal(result.state, 'queued');
  assert.equal(result.sessionId, registered.sessionId);
});

test('a stopped harness is woken and adopts exactly the session holding the command', t => {
  const peers = mailbox(t);
  // An expired registration the harness left behind when it exited.
  const old = JSON.parse(peers.register({ harness: 'claude', mode: 'cli',
    project: 'P', chatUrl: CHAT }));
  let launched = null;
  const result = send(peers, {
    sessionLiveness: () => 'stopped',
    wake: args => {
      const session = JSON.parse(peers.provision({ harness: 'claude', mode: 'cli',
        project: args.project, chatUrl: args.chatUrl }));
      const queued = JSON.parse(peers.send({ ...args, sessionId: session.sessionId }));
      launched = { ...args, sessionId: session.sessionId };
      return { harness: 'claude', mode: 'cli', state: 'running',
        sessionId: session.sessionId, taskId: 'cli-1', queued,
        confirmedExecution: false };
    },
  }, { harness: 'claude', project: 'P', chatUrl: CHAT, taskId: 't2',
    messageId: 'm2', command: 'REQUEST', message: 'Pick up where you left off' });

  assert.equal(result.wake.state, 'running');
  assert.equal(result.wake.confirmedExecution, false);
  assert.equal(result.state, 'queued', 'the message itself is still only queued');
  // A stopped registration keeps any work it had queued, and the woken process
  // adopts that same identity instead of forking a second mailbox.
  assert.equal(result.sessionId, old.sessionId, 'the woken harness adopts the existing session');
  assert.equal(launched.sessionId, result.sessionId);
  assert.equal(result.wake.taskId, 'cli-1');
  // The woken process polls the session named in its own instructions.
  const polled = JSON.parse(peers.poll({ sessionId: result.sessionId, chatUrl: CHAT }));
  assert.equal(polled.messages.length, 1);
  assert.equal(polled.messages[0].message, 'Pick up where you left off');
  assert.equal(polled.messages[0].taskId, 't2');

  // The abandoned-session path must not receive a duplicate of the new command.
  assert.equal(JSON.parse(peers.poll({ sessionId: old.sessionId, chatUrl: CHAT })).messages
    .filter(m => m.messageId === 'm2').length, 1);
});

test('wake:false queues for a running harness only and never starts one', t => {
  const peers = mailbox(t);
  const registered = JSON.parse(peers.register({ harness: 'dsh', mode: 'cli',
    project: 'P', chatUrl: CHAT }));
  let wakes = 0;
  const result = send(peers, {
    sessionLiveness: () => 'stopped',
    wake: () => { wakes++; throw Error('wake:false must not start anything'); },
  }, { harness: 'dsh', project: 'P', chatUrl: CHAT, taskId: 't3',
    messageId: 'm3', command: 'REQUEST', message: 'Later', wake: false });
  assert.equal(wakes, 0);
  assert.equal(result.sessionId, registered.sessionId);
  assert.equal(result.state, 'queued');
});

test('ambiguous registrations are never resolved by starting yet another harness', t => {
  const peers = mailbox(t);
  peers.register({ harness: 'claude', mode: 'cli', project: 'A', chatUrl: CHAT });
  peers.register({ harness: 'claude', mode: 'desktop', project: 'B', chatUrl: CHAT });
  let wakes = 0;
  assert.throws(() => send(peers, {
    sessionLiveness: () => 'stopped',
    wake: () => { wakes++; throw Error('must not guess'); },
  }, { harness: 'claude', chatUrl: CHAT, taskId: 't4', messageId: 'm4',
    command: 'REQUEST', message: 'Which one?' }), /Multiple matching sessions/);
  assert.equal(wakes, 0);
});
