import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig, createDesktopInbox, createLocalMcpTransport,
} from '../integrations/dsh-desktop-inbox/index.mjs';

const CHAT = 'https://chatgpt.com/c/6ad7ba74-f234-83e9-881b-9edf32b44915';
const BASE = { enabled: true, chatUrl: CHAT, nativeSessionId: 'session-dsh-01', project: 'DSH Desktop Test' };
const MSG = { messageId: 'MAGPIE_WEB_PING_001_20261021', taskId: 'MAGPIE_WEB_PING_001',
  command: 'REQUEST', message: 'Ping please' };

test('Desktop inbox defaults off and rejects ambiguous native targets', async () => {
  assert.deepEqual(validateConfig({}), { enabled: false });
  assert.throws(() => validateConfig({ ...BASE, nativeSessionId: '' }), /Native DSH Session ID/);
  assert.throws(() => validateConfig({ ...BASE, chatUrl: 'https://example.com/chat' }), /Invalid ChatGPT/);
  assert.throws(() => validateConfig({ ...BASE, pollIntervalMs: 2 }), /pollIntervalMs/);
  const disabled = createDesktopInbox({}, {controller:{prompt(){throw Error('must not run')}}});
  assert.equal((await disabled.tick()).state, 'disabled');
});

test('register, poll, native Session Controller prompt, then ack in this order', async () => {
  const calls = [];
  const bridge = createDesktopInbox(BASE, {
    controller: { async prompt(request) {
      calls.push(['prompt', request]);
      return { accepted: true };
    } },
    call: async (name, args) => {
      calls.push([name, args]);
      if (name === 'agent_register') return {sessionId: 'registered-01'};
      if (name === 'agent_poll') return {messages: [MSG]};
      if (name === 'agent_ack') return {state:'acked'};
      throw Error('unexpected tool ' + name);
    },
  });
  const result = await bridge.tick();
  assert.equal(result.state, 'poll-complete');
  assert.equal(result.admitted, 1);
  assert.deepEqual(calls.map(x=>x[0]), ['agent_register', 'agent_poll', 'prompt', 'agent_ack']);
  assert.equal(calls[0][1].resumeExisting, true);
  assert.equal(calls[2][1].sessionId, BASE.nativeSessionId);
  assert.equal(calls[2][1].mode, 'queue');
  assert.equal(calls[2][1].requestId, 'magpie-'+MSG.messageId);
  assert.equal(calls[3][1].messageId, MSG.messageId);
  assert.equal(result.executionConfirmed, false);
  bridge.stop();
});

test('never acknowledge a rejected native prompt', async () => {
  const names = [];
  const bridge = createDesktopInbox(BASE, {
    controller: { async prompt() { return {accepted:false}; } },
    call: async name => {
      names.push(name);
      return name === 'agent_register' ? {sessionId:'registered-01'} : {messages:[MSG]};
    },
  });
  assert.equal((await bridge.tick()).state,'error');
  assert.deepEqual(names,['agent_register','agent_poll']);
});

test('retry after ack failure uses the same DSH requestId', async () => {
  const ids = [];
  let ackAttempts = 0;
  const bridge = createDesktopInbox(BASE, {
    controller: { async prompt(request) {ids.push(request.requestId); return {accepted:true};} },
    call: async name => {
      if(name==='agent_register') return {sessionId:'registered-01'};
      if(name==='agent_poll') return {messages:[MSG]};
      if(name==='agent_ack' && ++ackAttempts === 1) throw Error('MCP temporarily unavailable');
      if(name==='agent_ack') return {state:'acked'};
      throw Error('unexpected');
    },
  });
  assert.equal((await bridge.tick()).state,'error');
  assert.equal((await bridge.tick()).state,'poll-complete');
  assert.equal(ackAttempts,2);
  assert.deepEqual(ids,['magpie-'+MSG.messageId,'magpie-'+MSG.messageId]);
});

test('MCP transport can call only fixed local endpoint and parses tool result', async () => {
  const seen=[];
  assert.throws(() => createLocalMcpTransport({endpoint:'https://other.test/mcp'}), /fixed loopback/);
  const call = createLocalMcpTransport({fetchImpl:async (url, opts)=>{
    seen.push({url,body:JSON.parse(opts.body)});
    return {ok:true,json:async()=>({result:{content:[{type:'text',text:'{"sessionId":"local-1"}'}]}})};
  }});
  const result = await call('agent_register',{harness:'dsh'});
  assert.deepEqual(result,{sessionId:'local-1'});
  assert.equal(seen[0].url,'http://127.0.0.1:3425/mcp/magpie/tools');
  assert.equal(seen[0].body.params.name,'magpie-codex-bridge_agent_register');
});
