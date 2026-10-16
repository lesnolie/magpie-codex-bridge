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
})().catch((error) => {
  const s = document.getElementById('status');
  s.textContent = `项目管理界面初始化失败：${error?.message || error}`;
  s.classList.add('error');
});
