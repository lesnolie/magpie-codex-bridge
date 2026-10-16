/**
 * A read-only snapshot of models Magpie already exposes to Codex.
 * Magpie's community iframe blocks fetch and arbitrary host calls, but
 * permits scripts in the plugin's own page directory. The local plugin
 * produces a *data-only* JS file there; no credentials, URLs, prompts or
 * raw Codex catalog objects cross into the sandbox.
 */
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const GATEWAY_URL = 'http://127.0.0.1:3425/v1/codex/models';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;
const PAGE_FILE = fileURLToPath(new URL('../page/model-catalog.js', import.meta.url));
let timer;

export function sanitizeCodexCatalog(input) {
  if (!input || !Array.isArray(input.models)) throw new Error('Not a Codex model catalog');
  const seen = new Set();
  const out = [];
  for (const item of input.models) {
    if (!item || typeof item.slug !== 'string' || !item.slug.trim()) continue;
    if (item.visibility === 'hide' || item.visibility === 'hidden') continue;
    const id = item.slug.trim();
    if (id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.display_name === 'string' && item.display_name.trim()
      ? item.display_name.trim().slice(0, 160) : id;
    const efforts = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
        .map(level => typeof level?.effort === 'string' ? level.effort : '')
        .filter(level => /^(none|minimal|low|medium|high|xhigh|max)$/.test(level))
        .slice(0, 12) : [];
    out.push({
      id, name, group: id.includes('/') ? id.split('/')[0] : 'Codex',
      threadModel: id, modelProvider: 'magpie', efforts,
    });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

async function readMagpieGateway(fetcher) {
  // The address is intentionally a fixed loopback URL, never a user-supplied
  // external URL. Do not follow redirects or forward account secrets.
  const response = await fetcher(GATEWAY_URL, {
    headers: { Authorization: 'Bearer magpie-codex', Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error('Magpie gateway did not return a model catalog');
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_JSON_BYTES) throw new Error('Catalog too large');
  const raw = await response.text();
  if (raw.length > MAX_JSON_BYTES) throw new Error('Catalog too large');
  return sanitizeCodexCatalog(JSON.parse(raw));
}

async function readLocalCodexCatalog(codexHome) {
  // Magpie writes this *sanitized, API-key-free* catalog into the current
  // Codex home when the Codex Agent is configured to use its providers.
  const localPath = path.join(codexHome, 'magpie-models.json');
  const raw = await readFile(localPath, 'utf8');
  if (raw.length > MAX_JSON_BYTES) throw new Error('Local catalog too large');
  return sanitizeCodexCatalog(JSON.parse(raw));
}

export async function discoverMagpieModels({
  fetcher = globalThis.fetch,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  try {
    const models = await readMagpieGateway(fetcher);
    return { source: 'Magpie Gateway', models };
  } catch {
    try {
      const models = await readLocalCodexCatalog(codexHome);
      return { source: 'Magpie Codex catalog', models };
    } catch {
      return {
        source: 'unavailable', models: [],
        warning: '无法连接 Magpie 本机模型目录，也没有找到 Codex 的 Magpie 模型缓存。',
      };
    }
  }
}

export async function publishModelCatalog(settings = {}, { target = PAGE_FILE } = {}) {
  const result = await discoverMagpieModels(settings);
  const data = { ...result, updatedAt: new Date().toISOString() };
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const js = 'globalThis.__magpieLocalModelCatalog = ' + json + ';\n';
  const tmp = target + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, js, { encoding: 'utf8', mode: 0o600 });
  try { await rename(tmp, target); }
  catch (error) {
    // Windows can refuse replacement while the iframe's file is open.
    // An atomic rename is preferable to exposing a half-written script.
    const { unlink } = await import('node:fs/promises');
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return { source: result.source, count: result.models.length };
}

export async function startModelCatalogSync(options = {}) {
  if (process.platform !== 'win32' || process.env.CI === 'true' || options.codexEnabled !== true) return;
  const update = async () => {
    try { await publishModelCatalog(); }
    catch (error) {
      console.warn('[magpie-local-review] Model catalog snapshot:', error?.message || String(error));
    }
  };
  await update();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void update(); }, 60_000);
  timer.unref?.();
}
