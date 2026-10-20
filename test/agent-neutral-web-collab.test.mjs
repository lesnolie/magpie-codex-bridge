import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserCollaborationPrompt } from '../src/codex-tasks.mjs';

test('Codex app-server collaboration keeps the execution mode and targets an exact chat', () => {
  const goal = 'Review the existing source without modifying files';
  const prompt = buildBrowserCollaborationPrompt({
    project: 'TMN',
    taskId: 'task-123',
    prompt: goal,
    chatUrl: 'https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b',
  });
  assert.match(prompt, /magpie-web-collab Skill/);
  assert.match(prompt, /EXECUTION: This is a Codex app-server task/);
  assert.match(prompt, /TARGET_CHAT: https:\/\/chatgpt\.com\/c\/6ad4df33-95c8-83ea-a043-bb1941e1392b/);
  assert.match(prompt, /PROJECT: TMN\nTASK_ID: task-123\n/);
  assert.ok(prompt.endsWith(goal));
  assert.ok(prompt.split('\n').length >= 10, 'instructions must contain actual line breaks');
});

test('Browser collaboration rejects untrusted destination URLs', () => {
  for (const value of [
    'https://not-chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b',
    'https://chatgpt.com.evil.test/c/6ad4df33-95c8-83ea-a043-bb1941e1392b',
    'https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b?bad=1',
    'https://chatgpt.com/',
  ]) assert.throws(() => buildBrowserCollaborationPrompt({
    project: 'TMN', taskId: 'task-123', prompt: 'readonly', chatUrl: value,
  }));
});
