import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTWebProvider, PROVIDER_ID, MODEL_ID } from '../index.mjs';

test('registers a model provider and no Codex app-server tools', async () => {
  const p = await ChatGPTWebProvider();
  assert.equal(p.tool, undefined);
  const cfg = {};
  await p.config(cfg);
  assert.equal(cfg.provider[PROVIDER_ID].api, 'http://127.0.0.1:18721/v1');
  assert.equal(cfg.provider[PROVIDER_ID].npm, '@ai-sdk/openai-compatible');
  assert.equal(cfg.provider[PROVIDER_ID].models[MODEL_ID].tool_call, true);
  assert.deepEqual(cfg.provider[PROVIDER_ID].models[MODEL_ID].modalities.input, ['text', 'image']);
});

test('preserves custom provider models', async () => {
  const p = await ChatGPTWebProvider();
  const cfg = { provider: { 'chatgpt-web': { models: { custom: { name: 'custom' } } } } };
  await p.config(cfg);
  assert.equal(cfg.provider['chatgpt-web'].models.custom.name, 'custom');
});

test('only attaches session headers to own provider', async () => {
  const p = await ChatGPTWebProvider();
  const o = { headers: {} };
  await p['chat.headers']({ model: { providerID: 'other' }, sessionID: 'x' }, o);
  assert.deepEqual(o.headers, {});
  await p['chat.headers']({ model: { providerID: 'chatgpt-web' }, sessionID: 's-1' }, o);
  assert.equal(o.headers['x-chatgpt-web-session'], 's-1');
});

test('auth clearly requires a local adapter key', async () => {
  const p = await ChatGPTWebProvider();
  const loader = await p.auth.loader(async () => ({ type: 'api', key: '' }));
  await assert.rejects(loader.fetch('http://127.0.0.1:18721/v1/chat/completions', {method:'POST'}), /Missing local adapter access key/);
});
