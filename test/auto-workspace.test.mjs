import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createChatSessions,resolveCurrentProject} from '../skills/magpie-codex-collab/chat-session.mjs';

const base=mkdtempSync(path.join(tmpdir(),'magpie-workspace-auto-'));
const tellmenext=path.join(base,'TellMeNext');
const updater=path.join(base,'tmn-updater');
const inner=path.join(tellmenext,'src');
mkdirSync(inner,{recursive:true});
mkdirSync(updater);
let workspace=inner;
const roots=()=>[
  {name:'tellmenext插件',root:tellmenext,source:'codex'},
  {name:'tmn-updater',root:updater,source:'codex'}
];
const chat=createChatSessions({projectRoots:roots,currentWorkspace:()=>workspace,
  folder:path.join(base,'sessions')});
const url='https://chatgpt.com/c/12345678-abcd-4bcd-8bcd-123456789abc';
const uuid='01a14de3-038d-7321-8325-93bdebc1fbb2';

test('automatic local selection uses the current registered workspace, not last manually selected project',()=>{
  assert.equal(resolveCurrentProject(roots(),inner).name,'tellmenext插件');
  assert.equal(chat.status().project,'tellmenext插件');
  assert.equal(chat.status('auto').project,'tellmenext插件');
  workspace=updater;
  assert.equal(chat.status().project,'tmn-updater');
  workspace=inner;
  assert.throws(()=>chat.request({project:'tmn-updater',taskId:'badbind',url}),/workspace mismatch/i);
  assert.equal(chat.status('tmn-updater').pending,null);
});
test('local browser verification and native thread registration stay pinned to correct project',()=>{
  const pending=chat.request({taskId:'tellmenext-001',url});
  assert.equal(pending.project,'tellmenext插件');
  assert.throws(()=>chat.activate({project:'tmn-updater',requestId:pending.pending.requestId,
    observedUrl:url,verifiedProject:'tmn-updater'}),/workspace mismatch/i);
  const active=chat.activate({requestId:pending.pending.requestId,
    observedUrl:url,verifiedProject:'tellmenext插件'});
  assert.equal(active.active.url,url);
  assert.equal(chat.findLinkedProject({chatUrl:url}),null,'unlinked chat is never auto-selected remotely');
  const good=chat.linkThread({taskId:'tellmenext-001',generation:active.active.generation,threadId:uuid});
  assert.equal(good.nativeThreadLinked,true);
  assert.equal(chat.findLinkedProject({chatUrl:url}),'tellmenext插件');
  assert.equal(chat.status('tmn-updater').nativeThreadLinked,false);
});
test('mismatched workspace cannot register a thread for a second project',()=>{
  workspace=updater;
  assert.throws(()=>chat.linkThread({project:'tellmenext插件',taskId:'tellmenext-001',
    generation:1,threadId:uuid}),/workspace mismatch/i);
  assert.equal(chat.status('tmn-updater').nativeThreadLinked,false);
  workspace=inner;
});
test('exact UUID safely unlinks a mistaken association without changing ChatGPT binding',()=>{
  const before=chat.status('tellmenext插件');
  assert.throws(()=>chat.unlinkThread({project:'tellmenext插件',threadId:'00000000-0000-4000-8000-000000000000'}),/Thread ID mismatch/);
  const unlinked=chat.unlinkThread({project:'tellmenext插件',threadId:uuid});
  assert.equal(unlinked.nativeThreadLinked,false);
  assert.deepEqual(unlinked.active,before.active);
  assert.equal(chat.findLinkedProject({chatUrl:url}),null);
});
test('unknown or ambiguous workspaces fail closed instead of choosing another project',()=>{
  const duplicate=[{name:'first',root:tellmenext,source:'codex'},{name:'second',root:tellmenext,source:'codex'}];
  assert.throws(()=>resolveCurrentProject(duplicate,tellmenext),/Ambiguous/);
  workspace=base;
  assert.throws(()=>chat.status(),/No unique Codex Desktop project/);
  assert.equal(chat.status('tmn-updater').project,'tmn-updater','explicit read-only status is still possible');
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
