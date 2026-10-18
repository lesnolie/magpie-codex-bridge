import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {createNativeCollab} from '../src/native-collab.mjs';

const chatUrl='https://chatgpt.com/c/ffffffff-1111-2222-3333-0123456789ab';

async function runLaunch(enabled, autoResponse='invoked-unconfirmed'){
  const dir=mkdtempSync(path.join(tmpdir(),'magpie-autosend-'));
  const root=path.join(dir,'project');
  mkdirSync(root);
  const roots=()=>[{name:'project',root,source:'codex'}];
  const chat=createChatSessions({projectRoots:roots,currentWorkspace:()=>root,folder:path.join(dir,'state')});
  let opened=0,sendCalls=0,receivedPrompt;
  const collab=createNativeCollab({
    codexEnabled:true,codexPermissionMode:'workspace-write',
    nativeDesktopAutoSendExperimental:enabled
  },{
    platform:'win32',chatSessions:chat,projectRoots:roots,
    openDesktop:async()=>{opened++;},
    desktopAutoSend:async prompt=>{receivedPrompt=prompt;sendCalls++;return autoResponse;}
  });
  try{
    const first=await collab.start({project:'project',goal:'Read-only test',chatUrl});
    const repeated=await collab.start({project:'project',goal:'Read-only test',chatUrl});
    return {first,repeated,opened,sendCalls,receivedPrompt,launch:chat.status('project').launch};
  }finally{rmSync(dir,{recursive:true,force:true});}
}

test('explicit local auto-send invokes only once, without claiming native execution',async()=>{
  const x=await runLaunch(true);
  assert.equal(x.opened,1);
  assert.equal(x.sendCalls,1);
  assert.match(x.receivedPrompt,/\$magpie-codex-collab/);
  assert.equal(x.first.autoSubmit,'invoked-unconfirmed');
  assert.equal(x.first.confirmedExecution,false);
  assert.equal(x.first.status,'opened_unconfirmed');
  assert.equal(x.launch.status,'opened_unconfirmed');
  assert.equal(x.repeated.reused,true);
});

test('disabled sender does not receive even a single prompt',async()=>{
  const x=await runLaunch(false);
  assert.equal(x.opened,1);
  assert.equal(x.sendCalls,0);
  assert.equal(x.first.autoSubmit,'disabled');
  assert.match(x.first.instructions,/press Send/i);
});

test('sender cannot verify does not claim execution or auto retry',async()=>{
  const x=await runLaunch(true,'not-verified');
  assert.equal(x.sendCalls,1);
  assert.equal(x.opened,1);
  assert.equal(x.first.autoSubmit,'not-verified');
  assert.equal(x.first.confirmedExecution,false);
  assert.match(x.first.instructions,/press Send/i);
});
