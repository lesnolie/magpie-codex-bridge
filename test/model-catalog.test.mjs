import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { discoverMagpieModels, publishModelCatalog, sanitizeCodexCatalog } from '../src/model-catalog.mjs';

const sample = {
  models: [
    { slug: 'deepseek/deepseek-v4', display_name: 'DeepSeek V4', visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      base_instructions: 'PROMPT MUST NOT LEAK', api_key: 'SECRET_KEY' },
    { slug: 'openai/gpt-demo', display_name: 'GPT Demo', visibility: 'list' },
    { slug: 'invisible/hidden', display_name: 'Hidden', visibility: 'hidden' },
  ],
};
const gateway = async () => ({
  ok: true, headers: { get: () => '1024' },
  text: async () => JSON.stringify(sample),
});

test('Magpie provider models are sanitized and grouped without credentials or prompts', () => {
  const models = sanitizeCodexCatalog(sample);
  assert.deepEqual(models.map(m => m.id), ['deepseek/deepseek-v4', 'openai/gpt-demo']);
  assert.deepEqual(models[0].efforts, ['low', 'high']);
  assert.equal(models[0].modelProvider, 'magpie');
  assert.equal(models[0].group, 'deepseek');
  assert.doesNotMatch(JSON.stringify(models), /SECRET_KEY|PROMPT MUST NOT LEAK/);
});

test('Magpie live gateway takes precedence over local Codex catalog', async () => {
  const result = await discoverMagpieModels({ fetcher: gateway, codexHome: '/missing' });
  assert.equal(result.source, 'Magpie Gateway');
  assert.equal(result.models[0].threadModel, 'deepseek/deepseek-v4');
});

test('offline Magpie gateway falls back to Magpie-written Codex file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'magpie-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'magpie-models.json'), JSON.stringify(sample));
  const result = await discoverMagpieModels({
    fetcher: async () => { throw new Error('unavailable'); },
    codexHome: root,
  });
  assert.equal(result.source, 'Magpie Codex catalog');
  assert.equal(result.models.length, 2);
});

test('snapshot is executable data-only JS in the plugin page, with no secrets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'magpie-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'model-catalog.js');
  const status = await publishModelCatalog({ fetcher: gateway, codexHome: '/missing' }, { target });
  assert.equal(status.count, 2);
  const source = await readFile(target, 'utf8');
  assert.doesNotMatch(source, /SECRET_KEY|PROMPT MUST NOT LEAK|api_key/);
  const context = {};
  runInNewContext(source, context);
  assert.equal(context.__magpieLocalModelCatalog.models[0].id, 'deepseek/deepseek-v4');
});

test('no gateway and no catalog publishes a clear empty state, not fake models', async () => {
  const result = await discoverMagpieModels({
    fetcher: async () => { throw new Error('offline'); }, codexHome: '/missing',
  });
  assert.equal(result.source, 'unavailable');
  assert.deepEqual(result.models, []);
  assert.match(result.warning, /无法连接/);
});
