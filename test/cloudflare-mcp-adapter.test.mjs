import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { makeVerifier, createBridge } from '../scripts/cloudflare-mcp-adapter.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', kty: 'RSA', use: 'sig' };
const domain = 'unit-test.cloudflareaccess.com';
const aud = 'unit-test-audience';
const makeJWT = (claimChanges = {}, headerChanges = {}, corrupt = false) => {
  const base = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = base({ kid: 'test-key', alg: 'RS256', ...headerChanges });
  const claims = base({ iss: `https://${domain}`, aud: [aud], exp: now + 300, iat: now - 1, ...claimChanges });
  const signed = `${header}.${claims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url');
  return `${signed}.${corrupt ? signature.slice(1) + 'A' : signature}`;
};
const check = makeVerifier({ teamDomain: domain, audience: aud, getKeys: async () => [key] });
const listen = srv => new Promise((resolve, reject) => srv.once('error', reject).listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const close = srv => new Promise(resolve => srv.close(resolve));

test('Cloudflare JWT checks signature, expiry, issuer, audience, algorithm', async () => {
  assert.equal((await check(makeJWT())).iss, `https://${domain}`);
  for (const x of [
    makeJWT({ exp: 0 }), makeJWT({ aud: 'other-app' }), makeJWT({ iss: 'https://evil.example' }),
    makeJWT({ nbf: Math.floor(Date.now() / 1000) + 200 }),
    makeJWT({}, { alg: 'none' }), makeJWT({}, {}, true), '',
  ]) await assert.rejects(check(x));
});

test('anonymous and unknown tool requests cannot read anything', async t => {
  let hits = 0;
  const upstream = http.createServer(async (req, res) => {
    hits++;
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'magpie-codex-bridge_projects' }, { name: 'sensitive_shell' }] } }));
  });
  const port = await listen(upstream);
  const bridge = createBridge({ verifyJWT: check, upstream: `http://127.0.0.1:${port}` });
  const bport = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  const invoke = async (payload, jwt, method = 'POST') => {
    const r = await fetch(`http://127.0.0.1:${bport}/mcp`, { method, headers: { 'content-type': 'application/json', ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}) }, ...((method === 'POST') ? { body: JSON.stringify(payload) } : {}) });
    return { status: r.status, reply: await r.json() };
  };
  const list = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
  assert.equal((await invoke(list)).status, 401);
  assert.equal(hits, 0);
  assert.equal((await invoke({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'shell' } }, makeJWT())).status, 403);
  const unavailable = await invoke({ jsonrpc: '2.0', method: 'resources/list', id: 1 }, makeJWT());
  assert.equal(unavailable.status, 403);
  assert.equal(unavailable.reply.reason, 'unsupported-method:resources/list');
  const invalidTool = await invoke({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'nonexistent' } }, makeJWT());
  assert.equal(invalidTool.reply.reason, 'tools-call-outside-allowlist');
  const browserRequest = await fetch(`http://127.0.0.1:${bport}/mcp`, {
    method: 'POST',
    headers: { Origin: 'https://example.invalid', 'content-type': 'application/json' },
    body: JSON.stringify(list),
  });
  assert.equal(browserRequest.status, 403);
  assert.equal((await browserRequest.json()).reason, 'origin-header-present');
  assert.equal(hits, 0);
  const ok = await invoke(list, makeJWT());
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.reply.result.tools.map(x => x.name), ['magpie-codex-bridge_projects']);
  assert.deepEqual(ok.reply.result.tools[0].annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.equal(hits, 1);
  const call = await invoke({ jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'magpie-codex-bridge_read_file', arguments: { project: 'TMN', file: 'README.md' } } }, makeJWT());
  assert.equal(call.status, 200);
  assert.equal(hits, 2);
  assert.equal((await invoke(list, makeJWT(), 'GET')).status, 405);
});

test('ChatGPT 2026 discovery is authenticated and handled without legacy upstream calls', async t => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => { upstreamHits++; res.writeHead(500).end(); });
  const upstreamPort = await listen(upstream);
  const bridge = createBridge({ verifyJWT: check, upstream: 'http://127.0.0.1:' + upstreamPort });
  const port = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  const request = {
    jsonrpc: '2.0', id: 'openai-mcp-discover', method: 'server/discover',
    params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'ChatGPT', version: '1.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    } },
  };
  const send = (token, payload = request) => fetch('http://127.0.0.1:' + port + '/mcp', {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'Mcp-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'server/discover',
      ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}),
    }, body: JSON.stringify(payload),
  });
  assert.equal((await send()).status, 401);
  const response = await send(makeJWT());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 'openai-mcp-discover');
  assert.equal(body.result.resultType, 'complete');
  assert.deepEqual(body.result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.equal(body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'magpie-local-review');
  assert.equal(body.result.cacheScope, 'private');
  assert.equal(upstreamHits, 0);
  assert.equal((await send(makeJWT(), { ...request, method: 'resources/list' })).status, 403);
});

test('MCP 2026 tool responses are adapted without granting extra tools', async t => {
  const methods = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const m = JSON.parse(raw);
    methods.push(m.method);
    const result = m.method === 'tools/list' ? { tools: [
      { name: 'magpie-codex-bridge_projects', description: 'Allowed', inputSchema: { type: 'object', properties: {} } },
      { name: 'other-plugin_danger', description: 'Forbidden', inputSchema: { type: 'object' } }
    ] } : { content: [{ type: 'text', text: '{"projects":[]}' }], isError: false };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  const upPort = await listen(upstream);
  const bridge = createBridge({ verifyJWT: check, upstream: 'http://127.0.0.1:' + upPort });
  const port = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  const send = async (method, modern, params = {}) => {
    const payload = { jsonrpc: '2.0', id: 7, method, params: modern
      ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {} } }
      : params };
    const response = await fetch('http://127.0.0.1:' + port + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Cf-Access-Jwt-Assertion': makeJWT(), ...(modern ? {
        'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': method
      } : {}) },
      body: JSON.stringify(payload)
    });
    return { status: response.status, body: await response.json() };
  };
  const list = await send('tools/list', true);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.result.tools.map(t => t.name), ['magpie-codex-bridge_projects']);
  assert.equal(list.body.result.resultType, 'complete');
  assert.equal(list.body.result.cacheScope, 'private');
  assert.equal(list.body.result.ttlMs, 0);
  const called = await send('tools/call', true, { name: 'magpie-codex-bridge_projects', arguments: {} });
  assert.equal(called.status, 200);
  assert.equal(called.body.result.resultType, 'complete');
  const denied = await send('tools/call', true, { name: 'other-plugin_danger', arguments: {} });
  assert.equal(denied.status, 403);
  const legacy = await send('tools/list', false);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.result.resultType, undefined);
  assert.deepEqual(methods, ['tools/list', 'tools/call', 'tools/list']);
});


test('Codex MCP tools remain hidden until local permission is enabled', async t => {
  const codexName = 'magpie-codex-bridge_codex_submit_task';
  const upstream = http.createServer(async (req, res) => {
    let data = '';
    for await (const part of req) data += part;
    const incoming = JSON.parse(data);
    const result = incoming.method === 'tools/list'
      ? { tools: [
          { name: 'magpie-codex-bridge_projects', inputSchema: { type: 'object' } },
          { name: codexName, inputSchema: { type: 'object' } },
          { name: 'unrelated_plugin_shell', inputSchema: { type: 'object' } },
        ] }
      : { content: [{ type:'text', text:'{"taskId":"test"}' }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({jsonrpc:'2.0', id:incoming.id, result}));
  });
  const upstreamPort = await listen(upstream);
  let enabled = false;
  const bridge = createBridge({
    verifyJWT: check, upstream: 'http://127.0.0.1:' + upstreamPort,
    isCodexEnabled: () => enabled,
  });
  const port = await listen(bridge);
  t.after(async () => { await close(bridge); await close(upstream); });
  const call = async (method, params) => {
    const res = await fetch('http://127.0.0.1:' + port + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Cf-Access-Jwt-Assertion':makeJWT() },
      body: JSON.stringify({ jsonrpc:'2.0', id:10, method, params }),
    });
    return { code:res.status, json:await res.json() };
  };
  let listing = await call('tools/list', {});
  assert.deepEqual(listing.json.result.tools.map(t=>t.name), ['magpie-codex-bridge_projects']);
  assert.equal((await call('tools/call', {name:codexName, arguments:{}})).code, 403);
  enabled = true;
  listing = await call('tools/list', {});
  assert.deepEqual(listing.json.result.tools.map(t=>t.name),
    ['magpie-codex-bridge_projects', codexName]);
  assert.equal(listing.json.result.tools[1].annotations.readOnlyHint, false);
  assert.equal(listing.json.result.tools[1].annotations.destructiveHint, true);
  assert.equal((await call('tools/call', {name:codexName, arguments:{}})).code, 200);
  assert.equal((await call('tools/call', {name:'unrelated_plugin_shell', arguments:{}})).code, 403);
});
