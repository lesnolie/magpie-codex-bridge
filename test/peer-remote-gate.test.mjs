import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../scripts/cloudflare-mcp-adapter.mjs';

function listen(s) { return new Promise(resolve => s.listen(0,'127.0.0.1',()=>resolve(s.address().port))); }
function close(s) { return new Promise(resolve => s.close(resolve)); }
const prefix='magpie-codex-bridge_';
const names=[
  'agent_sessions','agent_message_status','agent_message_send',
  'agent_register','agent_poll','agent_ack',
  'codex_submit_task','projects',
];

test('Cloudflare remote gate accepts peer sends only with independent local opt-in', async t => {
  let hits=0;
  const upstream=http.createServer(async(req,res)=>{
    hits++;
    let body=''; for await(const data of req) body+=data;
    const m=JSON.parse(body);
    const response=m.method==='tools/list'
      ? { jsonrpc:'2.0',id:m.id,result:{tools:names.map(name=>({name:prefix+name}))} }
      : {jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'queued'}]}};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));
  });
  const p=await listen(upstream); t.after(async()=>close(upstream));
  let peer=false;
  const bridge=createBridge({verifyJWT:async()=>({}),upstream:'http://127.0.0.1:'+p,
    isCodexEnabled:()=>false,isPeerEnabled:()=>peer});
  const q=await listen(bridge); t.after(async()=>close(bridge));
  async function ask(method,name) {
    const body={jsonrpc:'2.0',id:1,method,params:method==='tools/call'?{name:prefix+name,arguments:{}}:{}};
    const res=await fetch('http://127.0.0.1:'+q+'/mcp',
      {method:'POST',headers:{'content-type':'application/json','cf-access-jwt-assertion':'test'},
        body:JSON.stringify(body)});
    return { status:res.status, reply:await res.json() };
  }
  let r=await ask('tools/list');
  const allow=r.reply.result.tools.map(x=>x.name);
  assert.ok(allow.includes(prefix+'agent_sessions'));
  assert.ok(allow.includes(prefix+'agent_message_status'));
  assert.ok(!allow.includes(prefix+'agent_message_send'));
  assert.ok(!allow.includes(prefix+'agent_register'));
  assert.ok(!allow.includes(prefix+'agent_poll'));
  assert.ok(!allow.includes(prefix+'agent_ack'));
  assert.ok(!allow.includes(prefix+'codex_submit_task'));
  const previous=hits;
  assert.equal((await ask('tools/call','agent_message_send')).status,403);
  assert.equal(hits,previous,'disallowed tool must never reach upstream');
  peer=true;
  r=await ask('tools/list');
  assert.ok(r.reply.result.tools.some(x=>x.name===prefix+'agent_message_send'));
  assert.ok(!r.reply.result.tools.some(x=>x.name===prefix+'agent_register'));
  assert.equal((await ask('tools/call','agent_message_send')).status,200);
  assert.equal((await ask('tools/call','agent_register')).status,403);
  assert.equal((await ask('tools/call','agent_poll')).status,403);
  assert.equal((await ask('tools/call','agent_ack')).status,403);
});
