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
        read: (name, params = {}) => request('read', { name, params }),
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
  const useCodexProjects = document.getElementById('useCodexProjects');
  const projectSourceStatus = document.getElementById('projectSourceStatus');
  const remoteAutoStart = document.getElementById('remoteAutoStart');
  const remoteStatus = document.getElementById('remoteStatus');
  const codexEnabled = document.getElementById('codexEnabled');
  const codexAllowWrites = document.getElementById('codexAllowWrites');
  const codexStatus = document.getElementById('codexStatus');
  const codexWriteConfirmation = document.getElementById('codexWriteConfirmation');
  const confirmCodexWrite = document.getElementById('confirmCodexWrite');
  const cancelCodexWrite = document.getElementById('cancelCodexWrite');
  const codexExecutable = document.getElementById('codexExecutable');
  const codexModel = document.getElementById('codexModel');
  const codexModelSearch = document.getElementById('codexModelSearch');
  const codexModelFallback = document.getElementById('codexModelFallback');
  const modelPickerStatus = document.getElementById('modelPickerStatus');
  const refreshModels = document.getElementById('refreshModels');
  const codexLegacyModel = document.getElementById('codexLegacyModel');
  const codexModelProvider = document.getElementById('codexModelProvider');
  const saveCodexConfig = document.getElementById('saveCodexConfig');
  let rows = Array.isArray(options.roots) ? options.roots.filter((r) => r && typeof r.name === 'string' && typeof r.path === 'string') : [];
  let busy = false;
  let pendingCodexWrite = false;
  let modelCatalog = [];
  let modelsAvailable = false;
  let selectedCatalogID = null;

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
    useCodexProjects.checked = options.projectSource === 'codex';
    useCodexProjects.disabled = busy;
    remoteAutoStart.checked = options.remoteAutoStart === true;
    remoteAutoStart.disabled = busy;
    codexEnabled.checked = options.codexEnabled === true;
    codexEnabled.disabled = busy;
    codexAllowWrites.checked = pendingCodexWrite || options.codexAllowWrites === true;
    // Local write consent can be set independently of Codex activation.
    // A disabled Codex runner remains unable to execute tasks even if write
    // consent was granted earlier. Do not lock the switch based on order.
    codexAllowWrites.disabled = busy;
    codexWriteConfirmation.hidden = !pendingCodexWrite;
    confirmCodexWrite.disabled = busy;
    cancelCodexWrite.disabled = busy;
    saveCodexConfig.disabled = busy;
    refreshModels.disabled = busy;
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
  useCodexProjects.addEventListener('change', async () => {
    if (busy) return;
    const source = useCodexProjects.checked ? 'codex' : 'manual';
    busy = true;
    render();
    try {
      const next = { ...options, projectSource: source };
      const saved = await magpie.options.set(next);
      options = saved || next;
      projectSourceStatus.textContent = source === 'codex'
        ? '已切换到 Codex Desktop 项目。现有手动添加记录保留，但不会参与项目读取或 Codex 任务提交。'
        : '已切换回 Magpie 手动项目。';
      projectSourceStatus.classList.remove('error');
    } catch (error) {
      projectSourceStatus.textContent = '切换失败：' + (error?.message || error);
      projectSourceStatus.classList.add('error');
    } finally {
      busy = false;
      render();
    }
  });
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
  codexEnabled.addEventListener('change', () => {
    pendingCodexWrite = false;
    void saveCodexOption('codexEnabled', codexEnabled.checked);
  });
  codexAllowWrites.addEventListener('change', () => {
    if (busy) return;
    if (codexAllowWrites.checked && options.codexAllowWrites !== true) {
      // Native modal dialogs are blocked in Magpie's sandboxed iframe.
      // Show a second, explicit in-page authorization action instead.
      pendingCodexWrite = true;
      codexStatus.textContent = '请在下方点击“确认授权”，写入权限才会保存。';
      codexStatus.classList.remove('error');
      render();
      return;
    }
    pendingCodexWrite = false;
    void saveCodexOption('codexAllowWrites', codexAllowWrites.checked);
  });
  confirmCodexWrite.addEventListener('click', () => {
    if (busy || !pendingCodexWrite) return;
    pendingCodexWrite = false;
    void saveCodexOption('codexAllowWrites', true);
  });
  cancelCodexWrite.addEventListener('click', () => {
    if (busy || !pendingCodexWrite) return;
    pendingCodexWrite = false;
    codexStatus.textContent = '已取消写入授权，权限没有变更。';
    codexStatus.classList.remove('error');
    render();
  });
  function modelOptions(search = '') {
    // Dynamic catalog comes only from the Magpie-host-approved read.
    // Filtering never sends a search string to a remote provider.
    const query = search.toLowerCase().trim();
    const chosen = codexModel.value || selectedCatalogID || '';
    codexModel.replaceChildren();
    const inherit = document.createElement('option');
    inherit.value = '';
    inherit.textContent = '跟随 Codex 当前配置';
    codexModel.append(inherit);
    const groups = new Map();
    for (const entry of modelCatalog) {
      if (query && !(entry.name + ' ' + entry.group + ' ' + entry.id).toLowerCase().includes(query)) continue;
      const groupName = entry.group || '其他';
      let group = groups.get(groupName);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = groupName;
        groups.set(groupName, group);
        codexModel.append(group);
      }
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.name === entry.id ? entry.name : entry.name + ' · ' + entry.id;
      group.append(option);
    }
    if (chosen && !modelCatalog.some(entry => entry.id === chosen)) {
      const old = document.createElement('option');
      old.value = chosen;
      old.textContent = chosen + '（当前保存；目录外）';
      codexModel.append(old);
    }
    codexModel.value = chosen;
  }
  async function loadModels() {
    modelPickerStatus.textContent = '正在读取 Magpie 模型列表…';
    try {
      if (typeof magpie.read !== 'function') throw new Error('宿主未提供模型读取能力');
      const response = await magpie.read('models:list', { agent: 'codex' });
      const raw = Array.isArray(response) ? response : response?.models;
      if (!Array.isArray(raw)) throw new Error('宿主返回的模型目录格式不正确');
      modelCatalog = raw.filter(m =>
        m && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 &&
        typeof m.name === 'string' && m.hidden !== true
      ).map(m => ({
        id: m.id, name: m.name, group: typeof m.group === 'string' ? m.group : '',
        threadModel: typeof m.threadModel === 'string' && m.threadModel ? m.threadModel : m.id,
        modelProvider: typeof m.modelProvider === 'string' ? m.modelProvider : '',
      }));
      modelsAvailable = true;
      // Match by Codex thread model and provider, not by friendly display name.
      const current = modelCatalog.find(m => m.threadModel === options.codexModel &&
        m.modelProvider === (options.codexModelProvider || ''));
      selectedCatalogID = current?.id || options.codexModel || '';
      modelOptions(codexModelSearch.value);
      codexLegacyModel.open = false;
      modelPickerStatus.textContent = modelCatalog.length
        ? '已从 Magpie 同步 ' + modelCatalog.length + ' 个模型。修改后点击“保存 Codex 设置”。'
        : 'Magpie 没有可用模型；可选“跟随 Codex 当前配置”。';
    } catch (err) {
      modelsAvailable = false;
      modelCatalog = [];
      selectedCatalogID = options.codexModel || '';
      modelOptions();
      codexLegacyModel.open = true;
      modelPickerStatus.textContent = '当前 Magpie 宿主尚未开放模型目录读取权限；请更新支持 models:list 的宿主。仍可在高级配置中保留旧模型 ID。';
    }
  }
  codexExecutable.value = options.codexExecutable || '';
  codexModel.value = options.codexModel || '';
  codexModelFallback.value = options.codexModel || '';
  codexModelProvider.value = options.codexModelProvider || '';
  codexModel.addEventListener('change', () => { selectedCatalogID = codexModel.value; });
  codexModelSearch.addEventListener('input', () => modelOptions(codexModelSearch.value));
  refreshModels.addEventListener('click', () => { void loadModels(); });

  saveCodexConfig.addEventListener('click', async () => {
    if (busy) return;
    const exe = codexExecutable.value.trim().replace(/^\"|\"$/g, '');
    if (exe && !/^[a-zA-Z]:[\\\\/]/.test(exe)) {
      codexStatus.textContent = '请填写 codex.exe 的完整 Windows 路径，或留空自动检测。';
      codexStatus.classList.add('error');
      return;
    }
    busy = true;
    render();
    try {
      const selected = modelsAvailable ? modelCatalog.find(m => m.id === codexModel.value) : null;
      const useCatalog = modelsAvailable && (codexModel.value === '' || Boolean(selected));
      // Catalog IDs may differ from the actual Codex thread/start model.
      // Never silently replace a selected entry with a different model.
      const model = useCatalog ? (selected?.threadModel || '') : codexModelFallback.value.trim();
      const provider = useCatalog ? (selected?.modelProvider || '') : codexModelProvider.value.trim();
      if (modelsAvailable && codexModel.value && !selected) {
        throw new Error('选中的模型已不在 Magpie 目录中；请刷新并重新选择。');
      }
      const next = { ...options, codexExecutable: exe,
        codexModel: model, codexModelProvider: provider };
      const saved = await magpie.options.set(next);
      options = saved || next;
      codexModelFallback.value = next.codexModel;
      codexModelProvider.value = next.codexModelProvider;
      codexStatus.textContent = 'Codex 本地配置已保存。';
      codexStatus.classList.remove('error');
    } catch (error) {
      codexStatus.textContent = '保存失败：' + (error?.message || error);
      codexStatus.classList.add('error');
    } finally { busy = false; render(); }
  });
  projectSourceStatus.textContent = options.projectSource === 'codex'
    ? '当前项目来源：Codex Desktop 已登记的项目（自动同步）。'
    : '当前项目来源：Magpie 手动项目；开启上方开关即可切换到 Codex 项目。';
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
  void loadModels();
})().catch((error) => {
  const s = document.getElementById('status');
  const message = `项目管理界面初始化失败：${error?.message || error}。请检查 Magpie 是否已加载插件通信脚本。`;
  if (s) { s.textContent = message; s.classList.add('error'); }
  const fieldStatus = document.getElementById('fieldStatus');
  if (fieldStatus) { fieldStatus.textContent = message; fieldStatus.hidden = false; fieldStatus.classList.add('error'); }
});
