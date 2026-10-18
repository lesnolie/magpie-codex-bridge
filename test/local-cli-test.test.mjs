import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startLocalCliTest,runLocalCliTestWorker} from '../src/local-cli-test.mjs';

const base=mkdtempSync(path.join(tmpdir(),'magpie-cli-local-'));
const projectRoot=path.join(base,'allowed-project');
mkdirSync(projectRoot);
const projects=()=>[{name:'tmn-updater',root:projectRoot,source:'codex'}];
const url='https://chatgpt.com/c/ffffffff-1111-2222-3333-0123456789ab';
const opts={codexEnabled:true};
function dir(name){return path.join(base,name);}
function target(name){return path.join(base,name+'.js');}
function request(extra={}){return {id:randomUUID(),project:'tmn-updater',chatUrl:url,createdAt:Date.now(),...extra};}
function fakeSpawner(calls){
  return (...params)=>{
    calls.push(params);
    const child=new EventEmitter();
    child.unref=()=>{};
    queueMicrotask(()=>child.emit('spawn'));
    return child;
  };
}
function readState(name){return JSON.parse(readFileSync(path.join(dir(name),'native-cli-test.json'),'utf8'));}
const config=(name,spawns,extra={})=>({
  dir:dir(name),target:target(name),roots:projects,platform:'win32',
  getNode:async()=>'/fake/node.exe',spawnWorker:fakeSpawner(spawns),...extra
});

test('one local click emits precisely one fixed worker, reused option nonce is idempotent',async()=>{
  const spawns=[],req=request(),settings={...opts,nativeCliLocalTestRequest:req};
  const first=await startLocalCliTest(settings,config('single',spawns));
  assert.equal(first.status,'running');
  assert.equal(spawns.length,1);
  assert.match(spawns[0][1][0],/native-cli-test-runner\.mjs$/);
  assert.equal(spawns[0][2].shell,false);
  const repeated=await startLocalCliTest(settings,config('single',spawns));
  assert.equal(repeated.reused,true);
  assert.equal(spawns.length,1);
  const competing=await startLocalCliTest({...opts,nativeCliLocalTestRequest:request()},config('single',spawns));
  assert.equal(competing.status,'busy');
  assert.equal(spawns.length,1);
  const script=readFileSync(target('single'),'utf8');
  assert.ok(!script.includes(projectRoot));
  assert.ok(!script.includes(url));
  assert.ok(!script.includes('Bearer'));
  assert.ok(script.includes('tmn-updater'));
});

test('unknown project, malformed URLs and disabled flag cannot start CLI',async()=>{
  for(const [name,badSettings] of [
    ['unknown',{...opts,nativeCliLocalTestRequest:request({project:'not-allowed'})}],
    ['url',{...opts,nativeCliLocalTestRequest:request({chatUrl:'https://evil.example/c/abcdefgh'})}],
    ['urlquery',{...opts,nativeCliLocalTestRequest:request({chatUrl:url+'?token=secret'})}],
    ['disabled',{codexEnabled:false,nativeCliLocalTestRequest:request()}],
    ['expired',{...opts,nativeCliLocalTestRequest:request({createdAt:Date.now()-3600000})}]
  ]){
    const spawns=[];
    const result=await startLocalCliTest(badSettings,config(name,spawns));
    assert.equal(result.status,'rejected',name);
    assert.equal(spawns.length,0);
    assert.equal(readState(name).category,'invalid-request');
  }
});

test('runner enforces read-only / no approvals and does not equate exit 0 with chat verification',async()=>{
  const calls=[],spawns=[];
  const req=request();
  await startLocalCliTest({...opts,nativeCliLocalTestRequest:req},config('exit',spawns));
  await runLocalCliTestWorker(dir('exit'),req.id,{
    roots:projects,target:target('exit'),binary:()=>'/fake/codex.exe',
    cli:async params=>{calls.push(params);return {stdout:'All done'};},
    sessions:()=>({status:()=>({active:null})})
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].sandbox,'read-only');
  assert.equal(calls[0].approval,'never');
  assert.equal(calls[0].timeout,180000);
  assert.match(calls[0].prompt,/\$magpie-codex-collab/);
  assert.match(calls[0].prompt,/Do NOT edit/);
  assert.equal(readState('exit').status,'cli_exited_unverified');
  assert.equal(readState('exit').exitCode,0);
  assert.ok(!existsSync(path.join(dir('exit'),'native-cli-test.lock')));
});

test('verified chat requires matching test task ID AND exact URL',async()=>{
  const spawns=[],req=request();
  await startLocalCliTest({...opts,nativeCliLocalTestRequest:req},config('verified',spawns));
  await runLocalCliTestWorker(dir('verified'),req.id,{
    roots:projects,target:target('verified'),binary:()=>'/fake/codex.exe',
    cli:async()=>({stdout:''}),sessions:()=>({status:()=>({
      active:{url,taskId:'localtest-'+req.id}
    })})
  });
  assert.equal(readState('verified').status,'chat_verified');
});

test('browser unavailable self-report does not masquerade as verified',async()=>{
  const spawns=[],req=request();
  await startLocalCliTest({...opts,nativeCliLocalTestRequest:req},config('browser',spawns));
  await runLocalCliTestWorker(dir('browser'),req.id,{
    roots:projects,target:target('browser'),binary:()=>'/fake/codex.exe',
    cli:async()=>({stdout:'MAGPIE_BROWSER_UNAVAILABLE'}),
    sessions:()=>({status:()=>({active:null})})
  });
  assert.equal(readState('browser').status,'browser_unavailable_reported');
});

test('CLI failure returns redacted category and exit code, timeout distinct',async()=>{
  for(const [name,code,stderr,status,category] of [
    ['failed',17,'secret=MY_SUPER_SECRET_TOKEN','cli_failed','cli-failed'],
    ['timed','ETIMEDOUT','private/credential-file','timed_out','timeout'],
    ['argbad',2,"error: unrecognized option '--sandbox'",'cli_failed','cli-arguments-incompatible']
  ]){
    const spawns=[],req=request();
    await startLocalCliTest({...opts,nativeCliLocalTestRequest:req},config(name,spawns));
    await runLocalCliTestWorker(dir(name),req.id,{
      roots:projects,target:target(name),binary:()=>'/fake/codex.exe',
      cli:async()=>{throw Object.assign(new Error('unsafe path'),{code,stderr});}
    });
    const result=readState(name);
    assert.equal(result.status,status);
    assert.equal(result.category,category);
    assert.equal(result.exitCode,Number.isInteger(code)?code:null);
    assert.ok(!readFileSync(target(name),'utf8').includes('MY_SUPER_SECRET_TOKEN'));
    assert.ok(!JSON.stringify(result).includes('unsafe path'));
  }
});
test.after(()=>rmSync(base,{recursive:true,force:true}));
