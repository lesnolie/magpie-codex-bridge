import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { normalizeEndpoint, relayRequest } from '../src/relay.mjs';

async function fakeAdapter(onRequest) {
  const server = createServer(async (req, res) => {
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    await onRequest(req, Buffer.concat(chunks).toString(), res);
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  return {endpoint, close:()=>new Promise(r=>server.close(r))};
}

test('rejects off-origin HTTP endpoints and remote plain HTTP', () => {
  assert.throws(()=>normalizeEndpoint('http://example.com/v1'),/HTTPS/);
  assert.throws(()=>normalizeEndpoint('https://user:pass@example.com/v1'),/credentials/);
});

test('tool calls and real screenshots pass through with no placeholder conversion', async () => {
  const screenshot='data:image/png;base64,iVBORw0KGgo=';
  const payload = {model:'web', stream:false, tools:[{type:'function',function:{name:'cua_repl',parameters:{type:'object'}}}], messages:[{role:'user',content:[{type:'text',text:'Inspect screen'},{type:'image_url',image_url:{url:screenshot}}]}]};
  const fake=await fakeAdapter(async(req,body,res)=>{
    assert.equal(req.headers.authorization,'Bearer test-key');
    assert.equal(req.url,'/v1/chat/completions');
    assert.deepEqual(JSON.parse(body),payload);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',tool_calls:[{id:'call-1',type:'function',function:{name:'cua_repl',arguments:'{"action":"screenshot"}'}}]},finish_reason:'tool_calls'}]}));
  });
  try {
    const result=await relayRequest({endpoint:fake.endpoint,input:fake.endpoint+'/chat/completions',init:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)},key:'test-key'});
    assert.equal(result.status,200);
    const response=await result.json();
    assert.equal(response.choices[0].message.tool_calls[0].function.name,'cua_repl');
  } finally { await fake.close(); }
});

test('SSE frames pass through without editing or buffering into fake JSON', async () => {
  const frames='data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\ndata: [DONE]\n\n';
  const fake=await fakeAdapter(async(_req,_body,res)=>{res.setHeader('content-type','text/event-stream');res.end(frames)});
  try {
    const response=await relayRequest({endpoint:fake.endpoint,input:fake.endpoint+'/chat/completions',init:{method:'POST'},key:'a'});
    assert.equal(response.headers.get('content-type'),'text/event-stream');
    assert.equal(await response.text(),frames);
  } finally {await fake.close();}
});

test('refuses keys leaking off-origin or to unknown endpoint paths', async () => {
  const key='secret';
  const endpoint='http://127.0.0.1:18721/v1';
  await assert.rejects(relayRequest({endpoint,input:'https://example.com/v1/chat/completions',key}),/Refusing/);
  await assert.rejects(relayRequest({endpoint,input:'http://127.0.0.1:18721/admin',key}),/Refusing/);
});

test('missing upstream fails closed with actionable message', async () => {
  const err=new Error('connection refused');
  await assert.rejects(relayRequest({endpoint:'http://127.0.0.1:18721/v1',input:'http://127.0.0.1:18721/v1/chat/completions',key:'a',fetchImpl:async()=>{throw err}}),/No connection to the real ChatGPT Web service/);
});
