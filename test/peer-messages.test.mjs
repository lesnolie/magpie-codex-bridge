import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerMessages, normalizePeerChatUrl } from '../src/peer-messages.mjs';

const CHAT = 'https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';

function mailbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-peer-test-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return { directory, peer: createPeerMessages({ directory }) };
}

test('peer commands are queued through MCP and only acked after local poll', t => {
  const { directory, peer } = mailbox(t);
  const registered = JSON.parse(peer.register({ harness: 'claude', project: 'tmn-updater', chatUrl: CHAT }));
  assert.equal(registered.registration, 'local-agent');
  assert.equal(registered.identityVerified, false);
  const args = { sessionId: registered.sessionId, chatUrl: CHAT, taskId: 'task-01',
    messageId: 'web-msg-01', command: 'REQUEST', message: 'Please inspect the project structure.' };
  assert.equal(JSON.parse(peer.send(args)).state, 'queued');
  assert.equal(JSON.parse(peer.send(args)).reused, true);
  const observed = JSON.parse(peer.status({sessionId: args.sessionId, chatUrl: CHAT, messageId: args.messageId}));
  assert.equal(observed.message.state, 'queued');
  const independent = createPeerMessages({ directory });
  const messages = JSON.parse(independent.poll({sessionId: args.sessionId, chatUrl: CHAT})).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].command, 'REQUEST');
  assert.equal(JSON.parse(peer.status({sessionId: args.sessionId, chatUrl: CHAT, messageId: args.messageId})).message.state, 'delivered');
  assert.equal(JSON.parse(independent.acknowledge({sessionId: args.sessionId, chatUrl: CHAT, messageId: args.messageId})).state, 'acked');
  assert.equal(JSON.parse(peer.poll({sessionId: args.sessionId, chatUrl: CHAT})).messages.length, 0);
});

test('peer messages reject cross-chat replay and content changes using the same ID', t => {
  const { peer } = mailbox(t);
  const r = JSON.parse(peer.register({ harness: 'codex', project: 'TMN', chatUrl: CHAT }));
  const message = { sessionId: r.sessionId, chatUrl: CHAT, taskId:'task-2', messageId:'id-2',
    command: 'RESULT', message: 'completed tests' };
  assert.throws(() => peer.send({ ...message, chatUrl: CHAT + '/other' }));
  peer.send(message);
  assert.throws(() => peer.send({ ...message, message: 'different' }), /messageId already used/);
  assert.throws(() => peer.acknowledge({ sessionId: r.sessionId, chatUrl: CHAT, messageId: 'id-2' }), /Must poll/);
  assert.throws(() => peer.poll({sessionId:r.sessionId, chatUrl:'https://chatgpt.com/c/other-conversation-id'}));
  assert.equal(JSON.parse(peer.list()).sessions.length, 1);
});

test('malformed or non-ChatGPT URLs cannot register a peer session', t => {
  const { peer } = mailbox(t);
  for (const url of ['http://chatgpt.com/c/0123456789',
    'https://evil.test/c/0123456789',
    'https://chatgpt.com/c/0123456789?download=true',
    'https://chatgpt.com/',
  ]) {
    assert.throws(() => normalizePeerChatUrl(url));
    assert.throws(() => peer.register({harness:'claude', project:'TMN', chatUrl:url}));
  }
});

test('an expired registered agent cannot receive new messages', t => {
  const { directory } = mailbox(t);
  let clock = Date.parse('2026-10-21T02:00:00Z');
  const peer = createPeerMessages({ directory, now:() => clock });
  const r = JSON.parse(peer.register({harness:'opencode',project:'TMN',chatUrl:CHAT}));
  clock += 25 * 60 * 60 * 1000;
  assert.throws(() => peer.send({sessionId:r.sessionId,chatUrl:CHAT,taskId:'t-01',
    messageId:'msg-01',command:'REQUEST',message:'hello'}), /expired/);
});
