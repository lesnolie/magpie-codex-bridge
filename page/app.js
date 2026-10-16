/* Magpie community pages run in a sandboxed frame with no direct API access.
 * Implement the documented postMessage handshake in this already-loadable app.js;
 * no dependency on a separate /_magpie/bridge.js asset or relative URL.
 * The Magpie parent authorizes options.get / options.set for this plugin only. */
const magpie = (typeof globalThis.magpie === 'object' && globalThis.magpie)
  ? globalThis.magpie
  : (() => {
      const pending = new Map();
      let nextId = 0;
      const parentWindow = window.parent;
      function request(method, params) {
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Magpie 页面通信超时（' + method + '）。请确认 Magpie 版本支持插件页面。'));
          }, 8000);
          pending.set(id, { resolve, reject, timeout });
          try {
            parentWindow.postMessage({ magpie: 1, id, method, params }, '*');
          } catch (error) {
            clearTimeout(timeout);
            pending.delete(id);
            reject(error);
          }
        });
      }
      window.addEventListener('message', (event) => {
        if (event.source !== parentWindow) return;
        const msg = event.data;
        if (!msg || msg.magpie !== 1 || !Number.isInteger(msg.id)) return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timeout);
        if (msg.error) entry.reject(new Error(String(msg.error)));
        else entry.resolve(msg.result);
      });
      const api = {
        options: {
          get: () => request('options.get'),
          set: (options) => request('options.set', { options }),
        },
      };
      api.ready = request('hello');
      return api;
    })();

/* Magpie sandbox page. All writes go exclusively through magpie.options.set().
 * No network access, filesystem access or MCP tool to grant a root. */
(async () => {
  await magpie.ready;
  let options = await magpie.options.get() || {};
  const projects = document.getElementById('projects');
  const empty = document.getElementById('empty');
  const count = document.getElementById('count');
  const status = document.getElementById('status');
  const fieldStatus = document.getElementById('fieldStatus');
  const pathInput = document.getElementById('folder');
  const add = document.getElementById('add');
  const legacy = document.getElementById('legacy');
  const revoke = document.getElementById('revoke');
  const remoteAutoStart = document.getElementById('remoteAutoStart');
  const remoteStatus = document.getElementById('remoteStatus');
  const codexEnabled = document.getElementById('codexEnabled');
  const codexAllowWrites = document.getElementById('codexAllowWrites');
  const codexStatus = document.getElementById('codexStatus');
  let rows = Array.isArray(options.roots) ? options.roots.filter((r) => r && typeof r.name === 'string' && typeof r.path === 'string') : [];
  let busy = false;

  function updateStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
    fieldStatus.textContent = message;
    fieldStatus.hidden = !message;
    fieldStatus.classList.toggle('error', error);
  }
  function parsedFolder(value) {
    const folder = value.trim().replace(/^["']|["']$/g, '').trim().replace(/\\/g, '/');
    if (!folder || folder.includes('\0')) throw Error('请填写文件夹的完整路径。');
    if (!/^([A-Za-z]:\/|\/)/.test(folder)) throw Error('请填写绝对路径，例如 C:/work/TMN。');
    const clean = folder.replace(/\/+$/g, '');
    if (!clean || /^[A-Za-z]:$/.test(clean)) throw Error('不能授权整个磁盘。');
    return clean;
  }
  function suggestName(folder) {
    const leaf = folder.split('/').filter(Boolean).at(-1) || 'project';
    const base = leaf.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'project';
    let candidate = base;
    for (let i = 2; rows.some((r) => r.name === candidate); i++) candidate = `${base}-${i}`;
    return candidate;
  }
  function render() {
    projects.replaceChildren();
    count.textContent = `${rows.length} 个项目`;
    empty.hidden = rows.length > 0;
    for (const item of rows) {
      const li = document.createElement('li');
      const label = document.createElement('div');
      label.className = 'entry';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const dir = document.createElement('small');
      dir.textContent = item.path;
      label.append(name, dir);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'remove';
      del.textContent = '移除';
      del.disabled = busy;
      del.addEventListener('click', async () => {
        if (!confirm(`取消授权 ${item.name}？这将阻止新的 MCP 读取请求。`)) return;
        await save(rows.filter((r) => r.name !== item.name));
      });
      li.append(label, del);
      projects.append(li);
    }
    add.disabled = busy;
    pathInput.disabled = busy;
    revoke.disabled = busy;
    legacy.hidden = options.rootsSource === 'magpie-page';
    remoteAutoStart.checked = options.remoteAutoStart === true;
    remoteAutoStart.disabled = busy;
    codexEnabled.checked = options.codexEnabled === true;
    codexEnabled.disabled = busy;
    codexAllowWrites.checked = options.codexAllowWrites === true;
    codexAllowWrites.disabled = busy || options.codexEnabled !== true;
  }
  async function save(next) {
    if (busy) return;
    busy = true;
    render();
    try {
      // Mark page mode explicitly; an empty roots list revokes all prior permissions.
      const saved = await magpie.options.set({ ...options, rootsSource: 'magpie-page', roots: next });
      options = saved || { ...options, rootsSource: 'magpie-page', roots: next };
      rows = next;
      updateStatus('已保存。Magpie 将重新加载插件授权目录。');
      return true;
    } catch (err) {
      updateStatus(`保存失败：${err?.message || err}`, true);
      return false;
    } finally {
      busy = false;
      render();
    }
  }
  remoteAutoStart.addEventListener('change', async () => {
    if (busy) return;
    const requested = remoteAutoStart.checked;
    busy = true;
    render();
    try {
      const next = { ...options, remoteAutoStart: requested };
      const saved = await magpie.options.set(next);
      options = saved || next;
      remoteStatus.textContent = requested
        ? '已保存自动启动设置。Magpie 插件宿主加载后会安装并启动本机服务；首次生效需要确认服务确实运行。'
        : '已关闭自动启动设置。Magpie 插件宿主加载后将移除本插件创建的自启任务。';
      remoteStatus.classList.remove('error');
    } catch (error) {
      remoteStatus.textContent = '保存失败：' + (error?.message || error);
      remoteStatus.classList.add('error');
    } finally {
      busy = false;
      render();
    }
  });

  async function saveCodexOption(name, requested) {
    if (busy) return;
    if (name === 'codexAllowWrites' && requested &&
        !confirm('确认允许远程提交的 Codex 任务修改已授权项目？此操作可能更改或删除代码，务必先备份。')) {
      render();
      return;
    }
    busy = true;
    render();
    try {
      const next = { ...options, [name]: requested };
      if (name === 'codexEnabled' && !requested) next.codexAllowWrites = false;
      const saved = await magpie.options.set(next);
      options = saved || next;
      codexStatus.textContent = '已保存。需等待 Magpie 插件宿主加载/重载后生效；此提示并不证明远程可执行权限已经生效。';
      codexStatus.classList.remove('error');
    } catch (error) {
      codexStatus.textContent = '保存失败：' + (error?.message || error);
      codexStatus.classList.add('error');
    } finally {
      busy = false;
      render();
    }
  }
  codexEnabled.addEventListener('change', () => void saveCodexOption('codexEnabled', codexEnabled.checked));
  codexAllowWrites.addEventListener('change', () => void saveCodexOption('codexAllowWrites', codexAllowWrites.checked));
  codexStatus.textContent = options.codexEnabled === true
    ? 'Codex 接口已在本机配置为启用（不代表 ChatGPT Web 已获得执行权限）。'
    : 'Codex 接口默认关闭。';
  remoteStatus.textContent = options.remoteAutoStart === true
    ? '自动启动已启用（仅设置状态，非实际连接检测）。'
    : '自动启动未启用。';
  revoke.addEventListener('click', async () => {
    if (!confirm('撤销所有项目目录授权？此操作不会删除任何文件。')) return;
    await save([]);
  });
  // Magpie's iframe has sandbox="allow-scripts" and CSP form-action 'none':
  // browsers suppress form submit events. Use an explicit button click instead.
  async function addProject() {
    if (busy) return;
    try {
      const folder = parsedFolder(pathInput.value);
      if (rows.some((r) => r.path.replace(/\\/g, '/').toLowerCase() === folder.toLowerCase())) throw Error('这个文件夹已经添加。');
      const entry = { name: suggestName(folder), path: folder };
      if (await save([...rows, entry])) pathInput.value = '';
    } catch (err) {
      updateStatus(err.message, true);
      pathInput.focus();
    }
  }
  add.addEventListener('click', addProject);
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addProject();
    }
  });
  render();
  updateStatus('已连接 Magpie。请输入完整文件夹路径，然后点击添加项目。');
})().catch((error) => {
  const s = document.getElementById('status');
  const message = `项目管理界面初始化失败：${error?.message || error}。请检查 Magpie 是否已加载插件通信脚本。`;
  if (s) { s.textContent = message; s.classList.add('error'); }
  const fieldStatus = document.getElementById('fieldStatus');
  if (fieldStatus) { fieldStatus.textContent = message; fieldStatus.hidden = false; fieldStatus.classList.add('error'); }
});
