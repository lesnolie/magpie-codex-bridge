import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatSessions } from '../skills/magpie-codex-collab/chat-session.mjs';
import { createNativeCollab, desktopUrl, desktopPrompt, openCodexDesktop, queueToNativeThread } from '../src/native-collab.mjs';

const base=mkdtempSync(path.join(tmpdir(),'native-collab-'));
const root=path.join(base,'project');mkdirSync(root);
const projects=()=>[{name:'tmn-updater',root,source:'codex'}];
const chat=createChatSessions({projectRoots:projects,folder:path.join(base,'states')});
const opts={codexEnabled:true,codexPermissionMode:'workspace-write'};
const chatUrl='https://chatgpt.com/c/ffffffff-1111-2222-3333-0123456789ab';
const nextUrl='https://chatgpt.com/c/abcdefab-1111-2222-3333-abcdefabcdef';
const goal='Review tray start behavior, then make the requested fixes and tests';
let opened=[],queued=[];
const native=createNativeCollab(opts,{
  projectRoots:projects,chatSessions:chat,
  platform:'win32',openDesktop:async url=>{opened.push(url);},
  queueMessage:async(id,msg)=>{queued.push({id,msg});},binary:()=> 'C:\\native\\codex.exe',
});

test('no guessed ChatGPT URL: no launch, no local ticket, no side effects',async()=>{
  const res=await native.start({project:'tmn-updater',goal});
  assert.equal(res.status,'needs_chat_url');
  assert.equal(chat.status('tmn-updater').launch,null);
  assert.equal(opened.length,0);
  assert.equal(queued.length,0);
});

test('disabled or read-only local Codex permission fails closed',async()=>{
  const args={project:'tmn-updater',goal,chatUrl};
  const off=createNativeCollab({...opts,codexEnabled:false},{projectRoots:projects,chatSessions:chat});
  await assert.rejects(off.start(args),/local Codex permission/);
  const ro=createNativeCollab({...opts,codexPermissionMode:'read-only'},{projectRoots:projects,chatSessions:chat});
  await assert.rejects(ro.start(args),/read-only/);
  assert.equal(chat.status('tmn-updater').launch,null);
});

test('first startup prepares a local native Desktop composer without changing the chat',async()=>{
  const result=await native.start({project:'tmn-updater',goal,chatUrl});
  assert.equal(result.status,'opened_unconfirmed');
  assert.equal(result.confirmedExecution,false);
  assert.equal(result.activeChatUnchanged,true);
  assert.equal(result.chatUrl,chatUrl);
  assert.equal(result.transport,'desktop');
  assert.match(result.instructions,/Press Send/);
  assert.equal(opened.length,1);
  assert.match(opened[0],/^codex:\/\/threads\/new\?/);
  const url=new URL(opened[0]);
  assert.equal(url.searchParams.get('path'),root);
  const prompt=url.searchParams.get('prompt');
  assert.match(prompt,/\$magpie-codex-collab/);
  assert.ok(prompt.includes(chatUrl));
  assert.ok(prompt.includes(result.taskId));
  assert.ok(!JSON.stringify(result).includes(root),'MCP response must not expose absolute local root');
  assert.equal(chat.status('tmn-updater').active,null,'launch is not a verified chat bind');
});

test('tool retry is idempotent; changed goal or target cannot create duplicate execution',async()=>{
  const res=await native.start({project:'tmn-updater',goal,chatUrl});
  assert.equal(res.status,'opened_unconfirmed');
  assert.equal(res.reused,true);
  assert.equal(opened.length,1);
  await assert.rejects(native.start({project:'tmn-updater',goal:'Different goal',chatUrl}),/different native Codex launch/i);
  await assert.rejects(native.start({project:'tmn-updater',goal,chatUrl:nextUrl}),/different native Codex launch/i);
  assert.equal(opened.length,1);
});

test('Codex Skill verifies exact browser observed URL and project before activation',()=>{
  const launch=chat.status('tmn-updater').launch;
  const staged=chat.request({project:'tmn-updater',taskId:launch.taskId,url:chatUrl});
  assert.throws(()=>chat.activate({project:'tmn-updater',requestId:staged.pending.requestId,
    observedUrl:nextUrl,verifiedProject:'tmn-updater'}),/differs/);
  const bound=chat.activate({project:'tmn-updater',requestId:staged.pending.requestId,
    observedUrl:chatUrl,verifiedProject:'tmn-updater'});
  assert.equal(bound.active.url,chatUrl);
  assert.equal(bound.active.taskId,launch.taskId);
  assert.equal(bound.active.generation,1);
  chat.checkpoint({project:'tmn-updater',taskId:launch.taskId,generation:1,
    iteration:1,protocolState:'DONE',waitingFor:'none'});
  const uuid='aabbccdd-1234-4abc-8abc-abcdefabcdef';
  assert.throws(()=>chat.linkThread({project:'tmn-updater',taskId:'wrong-task',generation:1,threadId:uuid}),/Stale/);
  assert.throws(()=>chat.linkThread({project:'tmn-updater',taskId:launch.taskId,generation:1,threadId:'INVALID'}),/UUID/);
  chat.linkThread({project:'tmn-updater',taskId:launch.taskId,generation:1,threadId:uuid});
  assert.equal(chat.status('tmn-updater').nativeThreadLinked,true);
  assert.equal(chat.status('tmn-updater').launch.status,'acknowledged');
});

test('known locally bound thread may receive queued instruction but never claims delivery',async()=>{
  const result=await native.start({project:'tmn-updater',goal:'Run a new review',chatUrl});
  assert.equal(result.transport,'queue');
  assert.equal(result.status,'queued_unconfirmed');
  assert.equal(result.confirmedExecution,false);
  assert.equal(queued.length,1);
  assert.ok(queued[0].msg.includes(result.taskId));
  assert.equal(opened.length,1,'no duplicate Desktop tab should open');
  const second=await native.start({project:'tmn-updater',goal:'Run a new review',chatUrl});
  assert.equal(second.reused,true);
  assert.equal(queued.length,1);
});

test('unrelated chat URL is refused while native task is not completed',async()=>{
  await assert.rejects(native.start({project:'tmn-updater',goal:'Unrelated',chatUrl:nextUrl}),/different native Codex launch|Active chat differs/i);
  assert.equal(opened.length,1);
  assert.equal(queued.length,1);
});

test('desktop URL and process launcher use encoded protocol without shell injection',async()=>{
  const u=desktopUrl(root,desktopPrompt({project:'tmn-updater',
    goal:"Check text; ' ; & echo BAD",chatUrl,taskId:'native-001',launchId:'1'}));
  assert.equal(new URL(u).searchParams.get('path'),root);
  let binary,args,config;
  await openCodexDesktop(u,{platform:'win32',run:async(b,a,c)=>{binary=b;args=a;config=c;}});
  assert.equal(binary,'powershell.exe');
  assert.equal(args[1],'-NonInteractive');
  const script=Buffer.from(args[3],'base64').toString('utf16le');
  assert.ok(script.startsWith("$ErrorActionPreference='Stop';Start-Process -FilePath 'codex://"));
  assert.equal((script.match(/Start-Process/g)||[]).length,1);
  assert.equal(config.windowsHide,true);
  await assert.rejects(openCodexDesktop(u,{platform:'linux'}),/Windows only/);
  await assert.rejects(queueToNativeThread('bad','hello',{run:async()=>{}}),/Invalid verified/);
});

test.after(()=>rmSync(base,{recursive:true,force:true}));
