import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
  constructor() {
    this.events = {};
    this.children = [];
    this.classList = { toggle() {}, add() {}, contains() { return false; } };
    this.hidden = false;
    this.textContent = '';
    this.value = '';
  }
  addEventListener(event, callback) { this.events[event] = callback; }
  replaceChildren() { this.children = []; }
  append(...items) { this.children.push(...items); }
  async fire(event) { await this.events[event]?.({ preventDefault() {} }); }
}
const wait = () => new Promise((r) => setImmediate(r));

function runPage(initial = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let options = structuredClone(initial);
  const saved = [];
  const sandbox = {
    magpie: {
      ready: Promise.resolve(),
      options: {
        get: async () => structuredClone(options),
        set: async (opts) => { options = structuredClone(opts); saved.push(options); return structuredClone(options); },
      },
    },
    document: { getElementById: element, createElement: () => new Element() },
    confirm: () => true,
  };
  const src = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
  runInNewContext(src, sandbox);
  return { element, saved, get options() { return options; } };
}

test('embedded Magpie page adds a Windows project through options.set', async () => {
  const app = runPage();
  await wait();
  app.element('folder').value = '"C:\\work\\TMN"';
  await app.element('addForm').fire('submit');
  assert.equal(app.options.rootsSource, 'magpie-page');
  assert.deepEqual(app.options.roots, [{ name: 'TMN', path: 'C:/work/TMN' }]);
  assert.equal(app.element('folder').value, '');
});

test('embedded page revokes all roots even if an older picker exists', async () => {
  const app = runPage({ roots: [{ name: 'TMN', path: 'C:/work/TMN' }], anotherSetting: true });
  await wait();
  await app.element('revoke').fire('click');
  assert.equal(app.options.rootsSource, 'magpie-page');
  assert.deepEqual(app.options.roots, []);
  assert.equal(app.options.anotherSetting, true);
});

test('embedded page refuses to grant entire drive', async () => {
  const app = runPage();
  await wait();
  app.element('folder').value = 'C:\\';
  await app.element('addForm').fire('submit');
  assert.equal(app.saved.length, 0);
  assert.match(app.element('status').textContent, /不能授权整个磁盘/);
});
