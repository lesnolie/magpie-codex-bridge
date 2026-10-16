/**
 * Cloudflare Access -> Magpie local MCP, read-only.
 * Node >=20, no dependencies. Listens on loopback only.
 * Designed for an existing cloudflared route to http://127.0.0.1:48765.
 * Configure Cloudflare Access Managed OAuth on c2c.ilxyz.xyz and supply
 * CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD. No Cloudflare/Gateway secrets stored.
 */
import http from 'node:http';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PORT = 48765;
const MCP_PATH = '/mcp';
const MODERN_MCP_VERSION = '2026-07-28';
const SERVER_INFO = Object.freeze({ name: 'magpie-local-review', version: '0.4.5-alpha.1' });
const SERVER_META = Object.freeze({ 'io.modelcontextprotocol/serverInfo': SERVER_INFO });
const UPSTREAM = 'http://127.0.0.1:3425/mcp/magpie/tools';
const TOOL_NAMES = Object.freeze([
  'magpie-codex-bridge_projects',
  'magpie-codex-bridge_list_files',
  'magpie-codex-bridge_read_file',
  'magpie-codex-bridge_search_text',
  'magpie-codex-bridge_git_status',
  'magpie-codex-bridge_git_diff',
]);
const CODEX_NAMES = Object.freeze([
  'magpie-codex-bridge_codex_submit_task',
  'magpie-codex-bridge_codex_task_status',
  'magpie-codex-bridge_codex_task_result',
  'magpie-codex-bridge_codex_wait_task',
  'magpie-codex-bridge_codex_review_inbox',
  'magpie-codex-bridge_codex_review_changes',
  'magpie-codex-bridge_codex_cancel_task',
]);
const READ_ONLY = new Set(TOOL_NAMES);
const CODEX_PERMISSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-remote-enabled.flag');
const remoteCodexEnabled = () => existsSync(CODEX_PERMISSION_FILE);
const allowedTools = (enabled) => new Set(enabled ? [...TOOL_NAMES, ...CODEX_NAMES] : TOOL_NAMES);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(message) { throw new Error(message); }
function jsonResponse(res, status, object) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(object));
}
function base64urlJSON(segment) {
  if (!segment || !/^[a-zA-Z0-9_-]+$/.test(segment)) fail('Invalid JWT encoding');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}
function cfDomain(value) {
  let domain = String(value || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) fail('CF_ACCESS_TEAM_DOMAIN must be e.g. your-team.cloudflareaccess.com');
  return domain;
}
async function loadJWKS(domain) {
  const url = `https://${domain}/cdn-cgi/access/certs`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 256 * 1024) fail('Unable to fetch Cloudflare Access public certificates');
  const text = await response.text();
  if (text.length > 256 * 1024) fail('Cloudflare certificates too large');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.keys)) fail('Invalid Cloudflare JWKS');
  return parsed.keys;
}

/** Verify signature, issuer, audience, exp, nbf and iat, not merely a JWT header. */
export function makeVerifier({ teamDomain, audience, getKeys = loadJWKS }) {
  const domain = cfDomain(teamDomain);
  const expectedIssuer = `https://${domain}`;
  if (typeof audience !== 'string' || !/^[a-zA-Z0-9_-]{6,256}$/.test(audience)) fail('CF_ACCESS_AUD is missing or invalid');
  let cache = { at: 0, keys: [] };
  async function keys(force = false) {
    if (!force && Date.now() - cache.at < 5 * 60_000 && cache.keys.length) return cache.keys;
    const result = await getKeys(domain);
    if (!Array.isArray(result)) fail('Invalid JWKS');
    cache = { at: Date.now(), keys: result };
    return result;
  }
  return async function verifyJWT(jwt) {
    if (typeof jwt !== 'string' || jwt.length > 16 * 1024) fail('Missing Cloudflare Access JWT');
    const parts = jwt.split('.');
    if (parts.length !== 3) fail('Malformed Cloudflare Access JWT');
    const header = base64urlJSON(parts[0]);
    const claims = base64urlJSON(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 512) fail('Invalid JWT algorithm/key');
    let jwks = await keys();
    let jwk = jwks.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
    if (!jwk) {
      jwks = await keys(true); // Cloudflare may have rotated certificates
      jwk = jwks.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
    }
    if (!jwk) fail('Unrecognized Cloudflare signing key');
    const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) fail('Invalid Cloudflare JWT signature');
    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== expectedIssuer || !aud.includes(audience)) fail('Cloudflare JWT issuer/audience mismatch');
    if (!Number.isFinite(claims.exp) || claims.exp < now - 30) fail('Expired Cloudflare Access JWT');
    if (Number.isFinite(claims.nbf) && claims.nbf > now + 30) fail('Not-yet-valid Cloudflare JWT');
    if (Number.isFinite(claims.iat) && claims.iat > now + 30) fail('Future-issued Cloudflare JWT');
    return claims;
  };
}

/** Answer ChatGPT's 2026-07-28 capabilities probe here, not at legacy Magpie. */
function discoveryResult(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      supportedVersions: [MODERN_MCP_VERSION],
      capabilities: { tools: {} },
      _meta: SERVER_META,
      instructions: 'Six read-only review tools are always available. Seven Codex task and review tools are exposed only with local permission. Completion can be polled by ChatGPT while its turn is active; the server cannot initiate a new ChatGPT turn. Codex execution remains subject to local Magpie approval and client workspace policy.',
      ttlMs: 0,
      cacheScope: 'private',
    },
  };
}
function modernRequest(m, headers) {
  return headers['mcp-protocol-version'] === MODERN_MCP_VERSION ||
    m?.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === MODERN_MCP_VERSION;
}
function modernizeReply(reply, messages, headers) {
  const convert = (item, index) => {
    if (!item || !item.result || typeof item.result !== 'object') return item;
    const request = messages.find(m => m.id === item.id) || messages[index];
    if (!modernRequest(request, headers)) return item;
    const result = { ...item.result, resultType: 'complete',
      _meta: { ...item.result._meta, ...SERVER_META } };
    if (request?.method === 'tools/list') {
      result.ttlMs = 0;
      result.cacheScope = 'private';
    }
    return { ...item, result };
  };
  return Array.isArray(reply) ? reply.map(convert) : convert(reply, 0);
}
function inspectMessage(m, allowed) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0') return false;
  if (['server/discover', 'initialize', 'ping', 'notifications/initialized', 'tools/list'].includes(m.method)) return true;
  if (m.method !== 'tools/call') return false;
  if (!m.params || typeof m.params !== 'object' || Array.isArray(m.params)) return false;
  return allowed.has(m.params.name);
}
function filteredReply(reply, allowed) {
  const codexReadNames = ['_codex_task_status', '_codex_task_result', '_codex_wait_task', '_codex_review_inbox', '_codex_review_changes'];
  const codexRead = name => codexReadNames.some(suffix => name.endsWith(suffix));
  const filter = m => {
    if (m && m.result && Array.isArray(m.result.tools)) {
      m.result.tools = m.result.tools.filter(t => t && allowed.has(t.name)).map(t => ({
        ...t,
        annotations: { ...t.annotations,
          readOnlyHint: READ_ONLY.has(t.name) || codexRead(t.name),
          destructiveHint: t.name.endsWith('_codex_submit_task') || t.name.endsWith('_codex_cancel_task'),
          openWorldHint: false,
          idempotentHint: READ_ONLY.has(t.name) || t.name.endsWith('_codex_task_status') || t.name.endsWith('_codex_task_result'),
        },
      }));
    }
    return m;
  };
  return Array.isArray(reply) ? reply.map(filter) : filter(reply);
}
async function readBody(stream, limit) {
  const data = [];
  let total = 0;
  for await (const c of stream) {
    total += c.length;
    if (total > limit) fail('Request or response too large');
    data.push(c);
  }
  return Buffer.concat(data);
}
export function createBridge({ verifyJWT, upstream = UPSTREAM, isCodexEnabled = remoteCodexEnabled }) {
  if (typeof verifyJWT !== 'function') fail('JWT verifier required');
  return http.createServer(async (req, res) => {
    const started = Date.now();
    // Status-only logs: never emit JWTs, request bodies, source paths, or file contents.
    res.once('finish', () => console.log(
      `[mcp bridge] ${req.method} /mcp -> HTTP ${res.statusCode} (${Date.now() - started} ms)`
    ));
    try {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (pathname !== MCP_PATH || req.url !== MCP_PATH) return jsonResponse(res, 404, { error: 'Not found' });
      if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'POST MCP only' });
      if (req.headers.origin) {
        // Log only that Origin was present, never its value.
        console.warn('[mcp bridge] BLOCKED 403: Origin header present');
        return jsonResponse(res, 403, { error: 'Browser origins not allowed', reason: 'origin-header-present' });
      }
      const jwt = req.headers['cf-access-jwt-assertion'];
      try { await verifyJWT(jwt); } catch (error) {
        console.warn(`[mcp bridge] Cloudflare Access JWT rejected: ${error?.message || 'authentication failed'}`);
        return jsonResponse(res, 401, { error: 'Cloudflare Access authorization required' });
      }
      if (Number(req.headers['content-length'] || 0) > MAX_REQUEST_BYTES) return jsonResponse(res, 413, { error: 'Request too large' });
      const body = await readBody(req, MAX_REQUEST_BYTES);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { return jsonResponse(res, 400, { error: 'Invalid JSON' }); }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const allowed = allowedTools(isCodexEnabled());
      const rejected = messages.find(m => !inspectMessage(m, allowed));
      if (!messages.length || messages.length > 20 || rejected) {
        // Report only MCP method names, never arguments, tool names, project paths, or tokens.
        const method = rejected?.method;
        const methodLabel = typeof method === 'string' && /^[a-zA-Z][a-zA-Z0-9/_-]{0,63}$/.test(method)
          ? method : 'invalid-jsonrpc';
        const reason = messages.length > 20 ? 'oversized-batch'
          : messages.length === 0 ? 'empty-batch'
          : methodLabel === 'tools/call' ? 'tools-call-outside-allowlist'
          : methodLabel === 'invalid-jsonrpc' ? 'invalid-jsonrpc'
          : 'unsupported-method:' + methodLabel;
        console.warn('[mcp bridge] BLOCKED 403: ' + reason);
        return jsonResponse(res, 403, { error: 'Tool not allowed by the local Magpie permission policy', reason });
      }
      // MCP 2026-07-28 discovery isn't supported by the upstream Magpie's 2025-era API.
      if (messages.some(m => m.method === 'server/discover')) {
        if (messages.length !== 1 || messages[0].id === undefined || messages[0].id === null) {
          return jsonResponse(res, 400, { error: 'A single discovery request with an id is required' });
        }
        console.log('[mcp bridge] server/discover -> MCP 2026-07-28, tools only');
        return jsonResponse(res, 200, discoveryResult(messages[0].id));
      }
      const response = await fetch(upstream, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
        body, signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (response.status === 202) { res.writeHead(202, { 'cache-control': 'no-store' }); return res.end(); }
      if (!response.ok) {
        console.warn(`[mcp bridge] Magpie upstream responded HTTP ${response.status}`);
        return jsonResponse(res, 502, { error: 'Magpie MCP request failed', upstreamStatus: response.status });
      }
      const responseBody = await readBody(response.body, MAX_RESPONSE_BYTES);
      let reply;
      try { reply = JSON.parse(responseBody.toString('utf8')); } catch { return jsonResponse(res, 502, { error: 'Unexpected Magpie MCP response' }); }
      const filtered = modernizeReply(filteredReply(reply, allowed), messages, req.headers);
      if (messages.some(m => m.method === 'tools/list')) {
        const entries = Array.isArray(filtered) ? filtered : [filtered];
        const count = entries.reduce((total, entry) => total + (entry?.result?.tools?.length || 0), 0);
        console.log('[mcp bridge] tools/list returned ' + count + ' permission-filtered tools');
      }
      return jsonResponse(res, 200, filtered);
    } catch (error) {
      console.error('[mcp bridge]', error?.message || String(error));
      if (!res.headersSent) return jsonResponse(res, 502, { error: 'MCP bridge unavailable' });
      res.end();
    }
  });
}
function readLocalConfig() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const file = process.env.CF_MCP_CONFIG || path.join(appdata, 'magpie-local-review', 'cloudflare-mcp.json');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN || cfg.teamDomain, audience: process.env.CF_ACCESS_AUD || cfg.audience };
}
export function start() {
  const config = readLocalConfig();
  const verifyJWT = makeVerifier(config);
  const server = createBridge({ verifyJWT });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Cloudflare-protected Magpie MCP proxy listening at http://127.0.0.1:${PORT}${MCP_PATH}`);
    console.log('Cloudflare Access JWT verification ENABLED. Codex tools require local opt-in.');
  });
  server.on('error', error => { console.error('[mcp bridge]', error.message); process.exitCode = 1; });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) start();
