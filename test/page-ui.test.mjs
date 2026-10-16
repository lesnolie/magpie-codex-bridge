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
    this.focused = false;
  }
  addEventListener(event, callback) { this.events[event] = callback; }
  replaceChildren() { this.children = []; }
  append(...items) { this.children.push(...items); }
  focus() { this.focused = true; }
  async fire(event, extra = {}) { await this.events[event]?.({ preventDefault() {}, ...extra }); }
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
  await app.element('add').fire('click');
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
  await app.element('add').fire('click');
  assert.equal(app.saved.length, 0);
  assert.match(app.element('status').textContent, /不能授权整个磁盘/);
});

test('Magpie sandbox buttons never rely on forbidden form submission', async () => {
  const html = readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
  assert.match(html, /<button type="button" id="add">/);
  assert.doesNotMatch(html, /<form\b|type="submit"/);
  assert.match(script, /add\.addEventListener\('click', addProject\)/);
  assert.doesNotMatch(script, /addEventListener\('submit'/);
});

test('missing folder path shows a visible inline error and focuses the field', async () => {
  const app = runPage();
  await wait();
  await app.element('add').fire('click');
  assert.equal(app.saved.length, 0);
  assert.match(app.element('fieldStatus').textContent, /请填写文件夹/);
  assert.equal(app.element('fieldStatus').hidden, false);
  assert.equal(app.element('folder').focused, true);
});

test('enter inside the input adds the folder without submitting a form', async () => {
  const app = runPage();
  await wait();
  app.element('folder').value = 'C:\\\\projects\\\\Demo';
  await app.element('folder').fire('keydown', { key: 'Enter' });
  assert.equal(app.options.roots[0].name, 'Demo');
});

test('self-contained page never references the missing external Magpie bridge', () => {
  const html = readFileSync(new URL('../page/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+bridge\\.js/);
  assert.ok(js.includes("parentWindow.postMessage("));
  assert.ok(js.includes("request('hello')"));
});

test('UI presents an explicit ready state after Magpie options handshake', async () => {
  const app = runPage();
  await wait();
  assert.match(app.element('fieldStatus').textContent, /已连接 Magpie/);
  assert.equal(app.element('fieldStatus').hidden, false);
});

test('real Magpie message handshake initializes page without predefined global magpie', async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const received = [];
  const handlers = new Map();
  let savedOptions = {};
  const parent = {
    postMessage(message) {
      received.push(message);
      queueMicrotask(() => {
        let result = null;
        if (message.method === 'hello') result = { dark: false, lang: 'zh-CN', tokens: {} };
        if (message.method === 'options.get') result = structuredClone(savedOptions);
        if (message.method === 'options.set') {
          savedOptions = structuredClone(message.params.options);
          result = structuredClone(savedOptions);
        }
        handlers.get('message')?.({ source: parent, data: { magpie: 1, id: message.id, result } });
      });
    },
  };
  const window = { parent, addEventListener: (event, handler) => handlers.set(event, handler) };
  const sandbox = {
    window, document: { getElementById: element, createElement: () => new Element() },
    setTimeout, clearTimeout, confirm: () => true,
  };
  const source = readFileSync(new URL('../page/app.js', import.meta.url), 'utf8');
  runInNewContext(source, sandbox);
  await wait();
  await wait();
  assert.deepEqual(received.map(m => m.method), ['hello', 'options.get']);
  assert.match(element('fieldStatus').textContent, /已连接 Magpie/);
  element('folder').value = 'C:/work/TMN';
  await element('add').fire('click');
  assert.equal(savedOptions.rootsSource, 'magpie-page');
  assert.equal(savedOptions.roots[0].path, 'C:/work/TMN');
  assert.equal(received[2].method, 'options.set');
});
