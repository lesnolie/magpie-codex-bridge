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
  const status = document.getElementById('status');
  const remoteAutoStart = document.getElementById('remoteAutoStart');
  const remoteStatus = document.getElementById('remoteStatus');
  const codexEnabled = document.getElementById('codexEnabled');
  const codexPermissionMode = document.getElementById('codexPermissionMode');
  const codexPermissionConfirmation = document.getElementById('codexPermissionConfirmation');
  const codexPermissionWarning = document.getElementById('codexPermissionWarning');
  const confirmCodexPermission = document.getElementById('confirmCodexPermission');
  const cancelCodexPermission = document.getElementById('cancelCodexPermission');
  const codexStatus = document.getElementById('codexStatus');
  const codexExecutable = document.getElementById('codexExecutable');
  const nativeCollabCliExperimental = document.getElementById('nativeCollabCliExperimental');
  const codexModel = document.getElementById('codexModel');
  const codexModelSearch = document.getElementById('codexModelSearch');
  const codexModelFallback = document.getElementById('codexModelFallback');
  const modelPickerStatus = document.getElementById('modelPickerStatus');
  const refreshModels = document.getElementById('refreshModels');
  const codexLegacyModel = document.getElementById('codexLegacyModel');
  const codexModelProvider = document.getElementById('codexModelProvider');
  const saveCodexConfig = document.getElementById('saveCodexConfig');
  const localCliTestProject = document.getElementById('localCliTestProject');
  const localCliTestChatUrl = document.getElementById('localCliTestChatUrl');
  const localCliTestRun = document.getElementById('localCliTestRun');
  const localCliTestStatus = document.getElementById('localCliTestStatus');
  let cliTestBusy = false;
  let cliTestRunning = false;
  let cliTestPolling = null;
  let cliTestReload = 0;
  let cliProjects = [];

  let busy = false;
  let pendingMode = null;
  let modelCatalog = [];
  let modelsAvailable = false;
  let selectedCatalogID = null;

  function effectiveMode(config) {
    if (['read-only', 'workspace-write', 'codex-local'].includes(config.codexPermissionMode)) {
      return config.codexPermissionMode;
    }
    // Read old saved flags but do NOT keep the old permission system alive.
    if (config.codexAllowWrites === true) return config.codexInheritPermissions === true
      ? 'codex-local' : 'workspace-write';
    return 'read-only';
  }
  function cleanOptions(next) {
    // Migration removes obsolete grants when any setting is saved.
    const out = { ...next, projectSource: 'codex' };
    // Freeze the effective legacy mode before deleting the old flags.
    if (!['read-only','workspace-write','codex-local'].includes(out.codexPermissionMode)) {
      out.codexPermissionMode = next.codexEnabled === true ? effectiveMode(next) : 'read-only';
    }
    delete out.roots;
    delete out.rootsSource;
    delete out.codexAllowWrites;
    delete out.codexInheritPermissions;
    return out;
  }
  function render() {
    remoteAutoStart.checked = options.remoteAutoStart === true;
    remoteAutoStart.disabled = busy;
    codexEnabled.checked = options.codexEnabled === true;
    codexEnabled.disabled = busy;
    codexPermissionMode.value = pendingMode || effectiveMode(options);
    codexPermissionMode.disabled = busy;
    codexPermissionConfirmation.hidden = !pendingMode;
    confirmCodexPermission.disabled = busy;
    cancelCodexPermission.disabled = busy;
    saveCodexConfig.disabled = busy;
    refreshModels.disabled = busy;
    localCliTestRun.disabled = busy || cliTestBusy || cliTestRunning || options.codexEnabled !== true || !cliProjects.length;
  }
  async function saveOptions(next, success) {
    if (busy) return;
    busy = true;
    render();
    try {
      const clean = cleanOptions(next);
      const saved = await magpie.options.set(clean);
      options = cleanOptions(saved || clean);
      codexStatus.textContent = success || '已保存；Magpie 重新加载插件后生效。';
      codexStatus.classList.remove('error');
    } catch (error) {
      codexStatus.textContent = '保存失败：' + (error?.message || error);
      codexStatus.classList.add('error');
    } finally {
      busy = false;
      render();
    }
  }
  remoteAutoStart.addEventListener('change', async () => {
    if (busy) return;
    const next = remoteAutoStart.checked;
    await saveOptions({ ...options, remoteAutoStart: next });
    remoteStatus.textContent = options.remoteAutoStart
      ? '本地远程连接自动启动已配置。' : '本地远程连接自动启动未启用。';
  });
  codexEnabled.addEventListener('change', () => {
    pendingMode = null;
    const enabled = codexEnabled.checked;
    // Disabling the runner also revokes any previously saved write elevation.
    void saveOptions({ ...options, codexEnabled: enabled,
      codexPermissionMode: enabled ? effectiveMode(options) : 'read-only' });
  });
  codexPermissionMode.addEventListener('change', () => {
    if (busy) return;
    const next = codexPermissionMode.value;
    if (!['read-only','workspace-write','codex-local'].includes(next)) {
      render(); return;
    }
    if (next === effectiveMode(options)) { pendingMode = null; render(); return; }
    if (next === 'read-only') {
      pendingMode = null;
      void saveOptions({ ...options, codexPermissionMode: 'read-only' });
      return;
    }
    pendingMode = next;
    codexPermissionWarning.textContent = next === 'codex-local'
      ? '本地 Codex 可能拥有超出当前项目的文件写入权限。确认使用本机 Codex 权限配置？'
      : '确认允许 Codex 修改当前 Codex Desktop 项目中的文件？';
    codexStatus.textContent = '执行权限尚未更改，请在下方明确确认。';
    codexStatus.classList.remove('error');
    render();
  });
  confirmCodexPermission.addEventListener('click', () => {
    if (busy || !pendingMode) return;
    const mode = pendingMode;
    pendingMode = null;
    void saveOptions({ ...options, codexPermissionMode: mode });
  });
  cancelCodexPermission.addEventListener('click', () => {
    if (busy) return;
    pendingMode = null;
    codexStatus.textContent = '已取消执行权限变更。';
    codexStatus.classList.remove('error');
    render();
  });

  function modelOptions(search = '') {
    // Dynamic catalog comes only from the Magpie-host-approved read.
    // Filtering never sends a search string to a remote provider.
    const query = search.toLowerCase().trim();
    const chosen = selectedCatalogID || codexModel.value || '';
    codexModel.replaceChildren();
    const inherit = document.createElement('option');
    inherit.value = '';
    inherit.textContent = '跟随 Codex 当前配置';
    codexModel.append(inherit);
    const groups = new Map();
    for (const entry of modelCatalog) {
      if (query && entry.id !== chosen && !(entry.name + ' ' + entry.group + ' ' + entry.id).toLowerCase().includes(query)) continue;
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
  let catalogReload = 0;
  async function localSnapshot(refresh) {
    // Page CSP disallows direct network requests. Loading our own *data-only* script is
    // allowed by Magpie's pagePolicy and does not bypass the host API.
    if (refresh && document.head) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'model-catalog.js?reload=' + (++catalogReload);
        script.onload = () => { script.remove?.(); resolve(); };
        script.onerror = () => { script.remove?.(); reject(new Error('本地模型目录脚本读取失败')); };
        document.head.append(script);
      });
    }
    const snapshot = globalThis.__magpieLocalModelCatalog;
    if (!snapshot || !Array.isArray(snapshot.models) || (snapshot.source === 'unavailable' && !snapshot.models.length)) {
      throw new Error(snapshot?.warning || '本地模型目录尚未同步');
    }
    return snapshot;
  }
  async function loadModels(refresh = false) {
    modelPickerStatus.textContent = '正在读取模型列表…';
    let source = 'Magpie';
    try {
      let response;
      // The upstream API is optional. Current Magpie does not implement it.
      try {
        if (typeof magpie.read !== 'function') throw new Error('No host model read');
        response = await magpie.read('models:list', { agent: 'codex' });
      } catch {
        response = await localSnapshot(refresh);
        source = response.source || '本地 Codex 模型目录';
      }
      const raw = Array.isArray(response) ? response : response?.models;
      if (!Array.isArray(raw)) throw new Error('模型目录格式不正确');
      modelCatalog = raw.filter(m =>
        m && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 &&
        typeof m.name === 'string' && m.hidden !== true
      ).map(m => ({
        id: m.id, name: m.name, group: typeof m.group === 'string' ? m.group : '',
        threadModel: typeof m.threadModel === 'string' && m.threadModel ? m.threadModel : m.id,
        modelProvider: typeof m.modelProvider === 'string' ? m.modelProvider : '',
      }));
      modelsAvailable = true;
      const current = modelCatalog.find(m => m.threadModel === options.codexModel &&
        m.modelProvider === (options.codexModelProvider || '')) ||
        modelCatalog.find(m => m.threadModel === options.codexModel);
      selectedCatalogID = current?.id || options.codexModel || '';
      modelOptions(codexModelSearch.value);
      codexLegacyModel.open = false;
      modelPickerStatus.textContent = modelCatalog.length
        ? '已从' + source + '同步 ' + modelCatalog.length + ' 个模型。选择后点击保存。'
        : source + '暂无可用模型；可选择继承 Codex 当前配置。';
    } catch (err) {
      modelsAvailable = false;
      modelCatalog = [];
      selectedCatalogID = options.codexModel || '';
      modelOptions();
      codexLegacyModel.open = true;
      modelPickerStatus.textContent = '模型目录不可用：' + (err?.message || err) +
        '。可检查 Magpie Gateway 是否在运行，或暂时使用高级配置。';
    }
  }

  const cliLabels = {
    running:'本地 CLI 正在运行。等待只读测试完成…',
    cli_exited_unverified:'CLI 正常退出，但尚未验证 ChatGPT 会话绑定。',
    browser_unavailable_reported:'CLI 正常退出；Skill 报告内置浏览器不可用（自报，未独立验证）。',
    chat_verified:'Skill 已将当前测试任务与目标 ChatGPT 对话绑定（本地记录已验证）。',
    timed_out:'CLI 已超时（180 秒），没有确认会话绑定。',
    cli_failed:'CLI 启动/执行失败。',
    spawn_failed:'本地 Node.js 或独立测试运行器启动失败。',
    rejected:'本地测试请求被拒绝：项目、URL、系统平台或授权无效。',
    stale:'测试记录超时未更新；请检查本地运行器，不会自动重试。'
  };
  async function refreshLocalCliSnapshot() {
    // Same data-only script pattern as model-catalog.js. No fetch, HTTP or
    // new iframe capability. Never load a remote URL or execute options as JS.
    const script=document.createElement('script');
    script.src='native-cli-test-status.js?refresh='+(++cliTestReload);
    await new Promise((resolve,reject)=>{
      script.onload=resolve;
      script.onerror=()=>reject(new Error('无法读取本地测试状态快照'));
      document.head.append(script);
    }).finally(()=>script.remove());
    const snap=globalThis.__magpieLocalCliTest;
    if(!snap||!Array.isArray(snap.projects))throw new Error('状态快照格式无效');
    cliProjects=snap.projects.filter(p=>typeof p==='string'&&p.length<=96);
    const chosen=localCliTestProject.value;
    localCliTestProject.replaceChildren();
    const placeholder=document.createElement('option');
    placeholder.value='';placeholder.textContent='请选择已登记的 Codex 项目';
    localCliTestProject.append(placeholder);
    for(const p of cliProjects){
      const option=document.createElement('option');option.value=p;option.textContent=p;
      localCliTestProject.append(option);
    }
    if(cliProjects.includes(chosen))localCliTestProject.value=chosen;
    else if(cliProjects.includes('tmn-updater'))localCliTestProject.value='tmn-updater';
    const test=snap.test;
    const requested=options.nativeCliLocalTestRequest;
    const freshRequest=requested?.id && Number.isSafeInteger(requested.createdAt) &&
      Date.now()-requested.createdAt>=0 && Date.now()-requested.createdAt<120000;
    const awaiting=Boolean(freshRequest && requested.id!==test?.id);
    cliTestRunning=awaiting||test?.status==='running';
    if(awaiting){
      localCliTestStatus.textContent='等待本机插件接收新测试请求；请勿重复点击。';
      render();
      return;
    }
    if(test){
      const label=cliLabels[test.status]||'等待本机状态…';
      const suffix=test.exitCode!==null?' 退出码：'+test.exitCode+'。':'';
      const category=test.category?' 诊断类别：'+test.category+'。':'';
      localCliTestStatus.textContent=label+suffix+category;
      localCliTestStatus.classList.toggle('error',['cli_failed','timed_out','spawn_failed','rejected','stale'].includes(test.status));
      if(test.status!=='running'&&cliTestPolling){
        clearInterval(cliTestPolling);cliTestPolling=null;
      }
    } else {
      localCliTestStatus.textContent='尚未开始本机测试。';
    }
    render();
  }
  function beginCliTestPolling(){
    if(cliTestPolling)return;
    cliTestPolling=setInterval(()=>{void refreshLocalCliSnapshot().catch(err=>{
      localCliTestStatus.textContent='状态刷新失败：'+(err?.message||'未知错误');
    });},3500);
  }
  localCliTestRun.addEventListener('click',async()=>{
    if(busy||cliTestBusy||cliTestRunning||!cliProjects.length||options.codexEnabled!==true)return;
    const project=localCliTestProject.value;
    const chatUrl=localCliTestChatUrl.value.trim();
    if(!cliProjects.includes(project)){
      localCliTestStatus.textContent='请先选择已登记的项目。';return;
    }
    let url;
    try{
      url=new URL(chatUrl);
      if(url.protocol!=='https:'||url.hostname!=='chatgpt.com'||url.search||url.hash||
        !/^\/(?:g\/g-p-[\w-]+\/)?c\/[\w-]{8,}\/?$/.test(url.pathname))
        throw new Error('地址无效');
    }catch{
      localCliTestStatus.textContent='请输入完整且不含参数的 chatgpt.com/c/... 对话 URL。';return;
    }
    if(!globalThis.crypto?.getRandomValues){
      localCliTestStatus.textContent='当前页面缺少安全随机数接口，无法生成一次性测试 ID。';return;
    }
    function secureNonce(){
      const bytes=new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6]=(bytes[6]&0x0f)|0x40;
      bytes[8]=(bytes[8]&0x3f)|0x80;
      const h=Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('');
      return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
    }
    cliTestBusy=true;render();
    try{
      const request={id:secureNonce(),project,chatUrl,createdAt:Date.now()};
      const next=cleanOptions({...options,nativeCliLocalTestRequest:request});
      // Only this physical, locally-authorized button emits a request.
      const saved=await magpie.options.set(next);
      options=cleanOptions(saved||next);
      cliTestRunning=true;
      localCliTestStatus.textContent='测试已提交至本机 Magpie；正在等待插件重载并启动。';
      localCliTestStatus.classList.remove('error');
      beginCliTestPolling();
    }catch(err){
      localCliTestStatus.textContent='本地测试提交失败：'+(err?.message||err);
      localCliTestStatus.classList.add('error');
    }finally{cliTestBusy=false;render();}
  });
  void refreshLocalCliSnapshot().then(()=>{
    if(globalThis.__magpieLocalCliTest?.test?.status==='running')beginCliTestPolling();
  }).catch(err=>{localCliTestStatus.textContent='无法加载本机项目/状态：'+(err?.message||err);});

  codexExecutable.value = options.codexExecutable || '';
  nativeCollabCliExperimental.checked = options.nativeCollabCliExperimental === true;
  codexModel.value = options.codexModel || '';
  codexModelFallback.value = options.codexModel || '';
  codexModelProvider.value = options.codexModelProvider || '';
  codexModel.addEventListener('change', () => { selectedCatalogID = codexModel.value; });
  codexModelSearch.addEventListener('input', () => modelOptions(codexModelSearch.value));
  refreshModels.addEventListener('click', () => { void loadModels(true); });

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
        nativeCollabCliExperimental: nativeCollabCliExperimental.checked,
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
  codexStatus.textContent = options.codexEnabled === true
    ? 'Codex 任务接口已配置为启用（不代表远程 ChatGPT 已获得执行权限）。'
    : 'Codex 任务接口默认关闭。';
  remoteStatus.textContent = options.remoteAutoStart === true
    ? '自动启动已启用（仅设置状态，非实际连接检测）。'
    : '自动启动未启用。';
  render();
  status.textContent = '项目来源：Codex Desktop。旧的 Magpie 手动目录授权不再生效。';
  void loadModels();
})().catch((error) => {
  const s = document.getElementById('status');
  const message = `项目管理界面初始化失败：${error?.message || error}。请检查 Magpie 是否已加载插件通信脚本。`;
  if (s) { s.textContent = message; s.classList.add('error'); }
});
