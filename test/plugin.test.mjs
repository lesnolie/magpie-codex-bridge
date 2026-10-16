import test from 'node:test';
import assert from 'node:assert/strict';
import { MagpieCodexBridge } from '../index.mjs';

test('Magpie entry exports five tool hooks and does not provide project switching', async () => {
  const plugin = await MagpieCodexBridge();
  assert.deepEqual(Object.keys(plugin.tool).sort(), ['compact', 'continue', 'resume', 'status', 'threads']);
  for (const def of Object.values(plugin.tool)) {
    assert.equal(typeof def.description, 'string');
    assert.equal(typeof def.args, 'object');
    assert.equal(typeof def.execute, 'function');
  }
});

test('remote continue cannot be enabled by model arguments', async () => {
  const previous = process.env.CODEX_BRIDGE_ENABLE_CONTINUE;
  delete process.env.CODEX_BRIDGE_ENABLE_CONTINUE;
  try {
    const plugin = await MagpieCodexBridge();
    const answer = JSON.parse(await plugin.tool.continue.execute({ threadId: 'any', message: 'anything' }));
    assert.equal(answer.ok, false);
    assert.match(answer.error, /disabled/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_ENABLE_CONTINUE;
    else process.env.CODEX_BRIDGE_ENABLE_CONTINUE = previous;
  }
});
