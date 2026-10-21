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

test('explicit harness routing targets only the user-named harness without a session ID', t => {
  const { peer } = mailbox(t);
  const claude = JSON.parse(peer.register({ harness:'Claude Code', mode:'cli', project:'TMN', chatUrl:CHAT }));
  const codex = JSON.parse(peer.register({ harness:'codex', mode:'desktop', project:'TMN', chatUrl:CHAT }));
  const result = JSON.parse(peer.send({ harness:'Claude', chatUrl:CHAT, taskId:'task-claude',
    messageId:'msg-claude', command:'REQUEST', message:'Please inspect the UI.' }));
  assert.equal(result.harness,'claude');
  assert.equal(result.sessionId,claude.sessionId);
  assert.equal(result.mode,'cli');
  assert.equal(JSON.parse(peer.poll({sessionId:codex.sessionId,chatUrl:CHAT})).messages.length,0);
  assert.equal(JSON.parse(peer.poll({sessionId:claude.sessionId,chatUrl:CHAT})).messages.length,1);
  assert.throws(() => peer.send({ harness:'gemini',chatUrl:CHAT,taskId:'task-gemini',
    messageId:'msg-gemini', command:'REQUEST',message:'do work' }), /no registered session.*no substitute/);
  assert.throws(() => peer.send({ harness:'claude',sessionId:codex.sessionId,chatUrl:CHAT,
    taskId:'wrong',messageId:'wrong-id',command:'REQUEST',message:'do work' }), /does not match requested harness/);
});

test('same harness in multiple sessions requires explicit project, mode or session ID', t => {
  const { peer } = mailbox(t);
  const cli=JSON.parse(peer.register({ harness:'claude', mode:'cli', project:'A', chatUrl:CHAT }));
  const desktop=JSON.parse(peer.register({ harness:'claude', mode:'desktop', project:'B', chatUrl:CHAT }));
  const command={harness:'claude',chatUrl:CHAT,taskId:'multiple-01',
    messageId:'multi-msg-01',command:'REQUEST',message:'run tests'};
  assert.throws(()=>peer.send(command), /Multiple matching sessions/);
  const result=JSON.parse(peer.send({...command, project:'B'}));
  assert.equal(result.sessionId,desktop.sessionId);
  assert.equal(result.mode,'desktop');
  assert.equal(JSON.parse(peer.poll({sessionId:cli.sessionId,chatUrl:CHAT})).messages.length,0);
  assert.equal(JSON.parse(peer.poll({sessionId:desktop.sessionId,chatUrl:CHAT})).messages.length,1);
  assert.throws(()=>peer.send({...command,sessionId:desktop.sessionId, mode:'cli',messageId:'wrong-mode'}),
    /mode mismatch/);
});

test('opt-in reconnect reuses one DSH Desktop mailbox and preserves unacked messages', t => {
  const { peer } = mailbox(t);
  const binding = { harness:'dsh',mode:'desktop',project:'DSH Desktop Test',chatUrl:CHAT };
  const first = JSON.parse(peer.register(binding));
  peer.send({ sessionId:first.sessionId,chatUrl:CHAT,taskId:'ping-01',
    messageId:'ping-msg-01',command:'REQUEST',message:'hello' });
  const resumed = JSON.parse(peer.register({...binding,resumeExisting:true}));
  assert.equal(resumed.sessionId,first.sessionId);
  assert.equal(resumed.resumed,true);
  assert.equal(resumed.inboxPending,1);
  const polled = JSON.parse(peer.poll({sessionId:resumed.sessionId,chatUrl:CHAT}));
  assert.equal(polled.messages[0].messageId,'ping-msg-01');
});

test('opt-in reconnect refuses ambiguous sessions; legacy register still creates new session', t => {
  const { peer } = mailbox(t);
  const args = {harness:'dsh',mode:'desktop',project:'DSH Desktop Test',chatUrl:CHAT};
  peer.register(args);
  peer.register(args);
  assert.throws(()=>peer.register({...args,resumeExisting:true}),/Multiple matching/);
  assert.equal(JSON.parse(peer.list()).sessions.length,2);
});
