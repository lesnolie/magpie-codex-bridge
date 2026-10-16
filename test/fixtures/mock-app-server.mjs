import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const location = process.env.MOCK_CODEX_STORE;
if (!location) throw Error('MOCK_CODEX_STORE must point at a disposable test file');
const load = () => existsSync(location) ? JSON.parse(readFileSync(location, 'utf8')) : { threads: {} };
const save = (data) => writeFileSync(location, JSON.stringify(data));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => send({ id, result });
const error = (id, message) => send({ id, error: { code: -32602, message } });
let initialized = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const q = JSON.parse(line);
  if (q.method === 'initialize') return reply(q.id, { userAgent: 'test' });
  if (q.method === 'initialized') { initialized = true; return; }
  if (!initialized) return error(q.id, 'Not initialized');
  const store = load();
  const threadId = q.params?.threadId;
  const thread = store.threads[threadId];
  if (q.method === 'thread/start') {
    const id = 'thread-local-001';
    store.threads[id] = { id, name: 'Local test', cwd: 'D:\\TMN', status: 'idle', compactCount: 0, turns: [] };
    save(store); reply(q.id, { thread: { id } }); return;
  }
  if (q.method === 'thread/list') return reply(q.id, { data: Object.values(store.threads), nextCursor: null });
  if (!thread) return error(q.id, 'Unknown thread');
  if (q.method === 'thread/resume') return reply(q.id, { thread: { id: thread.id, status: thread.status }, cwd: thread.cwd, model: 'gpt-6' });
  if (q.method === 'thread/read') return reply(q.id, { thread });
  if (q.method === 'thread/compact/start') {
    thread.compactCount++;
    save(store);
    reply(q.id, {});
    setTimeout(() => {
      send({ method: 'item/completed', params: { threadId, item: { type: 'contextCompaction' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
    }, 10);
    return;
  }
  if (q.method === 'turn/start') {
    const id = `turn-${thread.turns.length + 1}`;
    thread.turns.push({ id, text: q.params.input[0].text });
    save(store);
    reply(q.id, { turn: { id, status: 'inProgress' } });
    setTimeout(() => {
      send({ method: 'item/agentMessage/delta', params: { threadId, delta: 'Test response: ' + q.params.input[0].text } });
      send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
    }, 100);
    return;
  }
  error(q.id, `unsupported: ${q.method}`);
});
