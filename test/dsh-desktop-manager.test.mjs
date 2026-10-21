import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {validateDesktopOptions,desktopPaths,reconcileDshDesktop,
  DSH_DESKTOP_INSTALL_REVISION} from '../src/dsh-desktop-manager.mjs';
import {createDesktopInbox} from '../integrations/dsh-desktop-inbox/index.mjs';

const CHAT='https://chatgpt.com/c/6ad7ba74-f234-83e9-881b-9edf32b44915';
const CONFIG={dshDesktopInboxEnabled:true,dshDesktopNativeSessionId:'native-dsh-01',
  dshDesktopChatUrl:CHAT,dshDesktopProject:'DSH Desktop Test'};

test('a Desktop binding needs a real native Session and exact ChatGPT URL',()=>{
  assert.deepEqual(validateDesktopOptions({}),{enabled:false});
  assert.throws(()=>validateDesktopOptions({...CONFIG,dshDesktopNativeSessionId:''}),/native Session ID/);
  assert.throws(()=>validateDesktopOptions({...CONFIG,dshDesktopChatUrl:'https://evil.example/c/123456789'}),/chatgpt.com/);
  assert.equal(validateDesktopOptions(CONFIG).nativeSessionId,'native-dsh-01');
});

test('Magpie stages a real DSH bundle and starts only an explicit local installer',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-dsh-desktop-test-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={...process.env,LOCALAPPDATA:home};
  const p=desktopPaths(env);let spawned=0;
  const deps={env,platform:'win32',findNode:async()=>process.execPath,
    launch:()=>{spawned++;const e=new EventEmitter();e.unref=()=>{};queueMicrotask(()=>e.emit('spawn'));return e;}};
  const r=await reconcileDshDesktop(CONFIG,deps);
  assert.equal(r.state,'installing');
  assert.equal(spawned,1);
  const packageJson=JSON.parse(fs.readFileSync(path.join(p.bundle,'package.json'),'utf8'));
  assert.equal(packageJson.dsh.bundle.patch,'./cordis.patch.yml');
  assert.match(fs.readFileSync(path.join(p.bundle,'cordis.patch.yml'),'utf8'),/magpie-dsh-desktop-inbox/);
  assert.equal(JSON.parse(fs.readFileSync(p.config,'utf8')).nativeSessionId,'native-dsh-01');
  await reconcileDshDesktop(CONFIG,deps);
  assert.equal(spawned,1,'quick plugin reload may not start duplicate installer');
  await reconcileDshDesktop({dshDesktopInboxEnabled:false},deps);
  assert.equal(fs.existsSync(p.config),false,'revocation removes local authorization immediately');
});

test('installed revision does not reinstall on every plugin refresh',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'magpie-dsh-desktop-installed-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const env={...process.env,LOCALAPPDATA:home},p=desktopPaths(env);
  fs.mkdirSync(p.base,{recursive:true});
  fs.writeFileSync(p.status,JSON.stringify({state:'installed',revision:DSH_DESKTOP_INSTALL_REVISION,
    updatedAt:new Date().toISOString()}));
  let count=0;
  const result=await reconcileDshDesktop(CONFIG,{env,platform:'win32',
    findNode:async()=>process.execPath,launch:()=>{count++;throw Error('unexpected');}});
  assert.equal(result.state,'installed');
  assert.equal(count,0);
});

test('Desktop authorization revocation prevents even polling',async()=>{
  const calls=[];
  const b=createDesktopInbox({enabled:true,nativeSessionId:'native-dsh-01',
    chatUrl:CHAT,project:'DSH Desktop Test'},{
      controller:{async prompt(){calls.push('prompt');return {accepted:true};}},
      call:async ()=>{calls.push('poll');return {sessionId:'m-1'};},
      authorized:()=>false,
    });
  assert.equal((await b.tick()).state,'authorization-revoked');
  assert.deepEqual(calls,[]);
});

test('Desktop mode is a separate native mailbox route, never dsh headless CLI',()=>{
  const src=fs.readFileSync(new URL('../index.mjs',import.meta.url),'utf8');
  assert.match(src,/selected === 'dsh' && a.mode === 'desktop'/);
  assert.match(src,/desktopReceiverConfigured:true/);
});
