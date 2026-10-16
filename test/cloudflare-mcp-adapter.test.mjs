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
  assert.equal((await invoke({ jsonrpc: '2.0', method: 'resources/list', id: 1 }, makeJWT())).status, 403);
  assert.equal(hits, 0);
  const ok = await invoke(list, makeJWT());
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.reply.result.tools.map(x => x.name), ['magpie-codex-bridge_projects']);
  assert.equal(hits, 1);
  const call = await invoke({ jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'magpie-codex-bridge_read_file', arguments: { project: 'TMN', file: 'README.md' } } }, makeJWT());
  assert.equal(call.status, 200);
  assert.equal(hits, 2);
  assert.equal((await invoke(list, makeJWT(), 'GET')).status, 405);
});
