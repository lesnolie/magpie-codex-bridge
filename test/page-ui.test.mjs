import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

class Element {
  constructor() {
    this.events={}; this.children=[]; this.hidden=false; this.textContent='';
    this.value=''; this.checked=false; this.disabled=false;
    this.classList={toggle(){},add(){},remove(){},contains(){return false;}};
  }
  addEventListener(event,listener){this.events[event]=listener;}
  append(...items){this.children.push(...items);}
  replaceChildren(){this.children=[];}
  focus(){}
  async fire(event,extra={}){ await this.events[event]?.({preventDefault(){},...extra});}
}
const pause=()=>new Promise(resolve=>setImmediate(resolve));

function runPage(initial={}, {models=null,snapshot=undefined,modelReadError=false}={}){
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,new Element());
    return elements.get(id);
  };
  let options=structuredClone(initial);
  const saved=[];
  const sandbox={
    __magpieLocalModelCatalog:snapshot,
    magpie:{
      ready:Promise.resolve(),
      options:{
        get:async()=>structuredClone(options),
        set:async next=>{
          options=structuredClone(next);saved.push(options);return structuredClone(options);
        },
      },
      read:async name=>{
        if(name!=='models:list'||modelReadError||!models)throw Error('not authorized');
        return {models:structuredClone(models)};
      },
    },
    document:{getElementById:element,createElement:()=>new Element()},
  };
  runInNewContext(readFileSync(new URL('../page/app.js',import.meta.url),'utf8'),sandbox);
  return {element,saved,get options(){return options;}};
}
const ready=async app=>{await pause();await pause();return app;};

test('only Codex Desktop source is visible, with a single execution permission select',()=>{
  const html=readFileSync(new URL('../page/index.html',import.meta.url),'utf8');
  assert.match(html,/Codex Desktop/);
  assert.match(html,/id="codexPermissionMode"/);
  assert.match(html,/value="read-only"/);
  assert.match(html,/value="workspace-write"/);
  assert.match(html,/value="codex-local"/);
  assert.doesNotMatch(html,/id="folder"|id="revoke"|id="useCodexProjects"|id="codexAllowWrites"|id="codexInheritPermissions"|id="add"/);
});

test('default state is read-only and never grants a directory',async()=>{
  const app=await ready(runPage());
  assert.equal(app.element('codexPermissionMode').value,'read-only');
  assert.equal(app.element('codexPermissionConfirmation').hidden,true);
  assert.equal(app.saved.length,0);
  assert.match(app.element('status').textContent,/Codex Desktop/);
});

test('legacy settings are displayed but removed on next save; manual roots are not inherited',async()=>{
  const app=await ready(runPage({
    projectSource:'manual',rootsSource:'magpie-page',
    roots:[{name:'Old',path:'C:/danger'}],
    codexEnabled:true,codexAllowWrites:true,codexInheritPermissions:true,
  }));
  assert.equal(app.element('codexPermissionMode').value,'codex-local');
  app.element('remoteAutoStart').checked=true;
  await app.element('remoteAutoStart').fire('change');
  await pause();
  assert.equal(app.options.projectSource,'codex');
  assert.equal(app.options.codexAllowWrites,undefined);
  assert.equal(app.options.codexInheritPermissions,undefined);
  assert.equal(app.options.roots,undefined);
  assert.equal(app.options.rootsSource,undefined);
  assert.equal(app.element('codexPermissionMode').value,'codex-local');
});

test('changing to workspace write needs second local confirmation',async()=>{
  const app=await ready(runPage({codexEnabled:true}));
  app.element('codexPermissionMode').value='workspace-write';
  await app.element('codexPermissionMode').fire('change');
  assert.equal(app.element('codexPermissionConfirmation').hidden,false);
  assert.equal(app.saved.length,0);
  await app.element('cancelCodexPermission').fire('click');
  assert.equal(app.element('codexPermissionMode').value,'read-only');
  assert.equal(app.saved.length,0);
  app.element('codexPermissionMode').value='workspace-write';
  await app.element('codexPermissionMode').fire('change');
  await app.element('confirmCodexPermission').fire('click');
  await pause();
  assert.equal(app.options.codexPermissionMode,'workspace-write');
  assert.equal(app.element('codexPermissionConfirmation').hidden,true);
});

test('Codex native permissions need confirmation, and return to read-only revokes immediately',async()=>{
  const app=await ready(runPage({codexEnabled:true,codexPermissionMode:'workspace-write'}));
  app.element('codexPermissionMode').value='codex-local';
  await app.element('codexPermissionMode').fire('change');
  assert.equal(app.saved.length,0);
  assert.match(app.element('codexPermissionWarning').textContent,/超出当前项目/);
  await app.element('confirmCodexPermission').fire('click');
  await pause();
  assert.equal(app.options.codexPermissionMode,'codex-local');
  app.element('codexPermissionMode').value='read-only';
  await app.element('codexPermissionMode').fire('change');
  await pause();
  assert.equal(app.options.codexPermissionMode,'read-only');
});

test('disabling runner revokes write even if local Codex permissions were selected',async()=>{
  const app=await ready(runPage({codexEnabled:true,codexPermissionMode:'codex-local'}));
  app.element('codexEnabled').checked=false;
  await app.element('codexEnabled').fire('change');
  await pause();
  assert.equal(app.options.codexEnabled,false);
  assert.equal(app.options.codexPermissionMode,'read-only');
});

test('model picker continues to use Magpie catalog and preserves selection',async()=>{
  const app=await ready(runPage({}, {models:[
    {id:'provider/demo',name:'Demo',group:'provider',threadModel:'provider/demo',modelProvider:'magpie'}
  ]}));
  assert.match(app.element('modelPickerStatus').textContent,/1 个模型/);
  app.element('codexModel').value='provider/demo';
  await app.element('codexModel').fire('change');
  await app.element('saveCodexConfig').fire('click');
  await pause();
  assert.equal(app.options.codexModel,'provider/demo');
  assert.equal(app.options.codexModelProvider,'magpie');
});

test('offline host can load a local model snapshot without direct fetch',async()=>{
  const app=await ready(runPage({}, {modelReadError:true,snapshot:{
    source:'Magpie Gateway',models:[{id:'a/b',name:'B',group:'a',threadModel:'a/b',modelProvider:'magpie'}],
  }}));
  assert.match(app.element('modelPickerStatus').textContent,/Magpie Gateway.*1 个模型/);
  const js=readFileSync(new URL('../page/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(js,/\bfetch\s*\(|XMLHttpRequest|child_process|execFile\(/);
  assert.match(js,/parentWindow\.postMessage/);
});

test('remote auto-start setting still works independently of Codex permissions',async()=>{
  const app=await ready(runPage({codexPermissionMode:'read-only'}));
  app.element('remoteAutoStart').checked=true;
  await app.element('remoteAutoStart').fire('change');
  await pause();
  assert.equal(app.options.remoteAutoStart,true);
  assert.equal(app.options.codexPermissionMode,'read-only');
});

test('Desktop auto-send saves on toggle and needs Codex enabled',async()=>{
  const html=readFileSync(new URL('../page/index.html',import.meta.url),'utf8');
  assert.match(html,/id="nativeDesktopAutoSendExperimental"/);
  const off=await ready(runPage());
  assert.equal(off.element('nativeDesktopAutoSendExperimental').checked,false);
  assert.equal(off.element('nativeDesktopAutoSendExperimental').disabled,true);
  assert.equal(off.element('codexPermissionMode').disabled,true);
  const app=await ready(runPage({codexEnabled:true}));
  assert.equal(app.element('nativeDesktopAutoSendExperimental').disabled,false);
  app.element('nativeDesktopAutoSendExperimental').checked=true;
  await app.element('nativeDesktopAutoSendExperimental').fire('change');
  await pause();
  assert.equal(app.options.nativeDesktopAutoSendExperimental,true);
  assert.equal(app.saved.length,1);
});

test('standalone CLI diagnostics are gone and stale CLI settings are dropped on save',async()=>{
  const html=readFileSync(new URL('../page/index.html',import.meta.url),'utf8');
  const js=readFileSync(new URL('../page/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/nativeCollabCliExperimental|localCliTest|native-cli-test/);
  assert.doesNotMatch(js,/localCliTest|native-cli-test-status|__magpieLocalCliTest/);
  const app=await ready(runPage({codexEnabled:true,nativeCollabCliExperimental:true,
    nativeCliLocalTestRequest:{id:'x',project:'p',chatUrl:'https://chatgpt.com/c/abcdefgh',createdAt:1}}));
  await app.element('saveCodexConfig').fire('click');
  await pause();
  assert.equal(app.options.nativeCollabCliExperimental,undefined);
  assert.equal(app.options.nativeCliLocalTestRequest,undefined);
  assert.equal(app.options.codexEnabled,true);
});
