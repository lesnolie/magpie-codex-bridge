import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHarnessRunner } from '../src/harness-runner.mjs';

const ROOT='/tmp/magpie-allowed-workspace';
const CHAT='https://chatgpt.com/c/6ad4df33-95c8-83ea-a043-bb1941e1392b';
function setup(options={}) {
  const launches=[];
  function fakeSpawn(command,args,opts) {
    const child=new EventEmitter();
    child.stdout=new PassThrough();
    child.stderr=new PassThrough();
    child.stdin=new PassThrough();
    child.kill=()=>{child.emit('close',null);};
    child.input='';
    child.stdin.on('data',d=>{child.input+=d.toString('utf8');});
    launches.push({command,args,opts,child});
    return child;
  }
  const runner=createHarnessRunner({
    agentLaunchEnabled:true,agentLaunchPermission:'read-only',...options
  },{spawn:fakeSpawn,platform:'linux',projectRoots:()=>[{name:'TMN',root:ROOT}],
    runLimitMs:5000});
  return {runner,launches};
}
test('select Claude, launch only Claude and deliver task through stdin',()=>{
  const {runner,launches}=setup();
  const r=JSON.parse(runner.launch({harness:'Claude Code',project:'TMN',
    prompt:'Inspect the layout',chatUrl:CHAT}));
  assert.equal(r.harness,'claude');
  assert.equal(r.mode,'cli');
  assert.equal(r.state,'running');
  assert.equal(launches.length,1);
  assert.equal(launches[0].command,'claude');
  assert.deepEqual(launches[0].args,['--print','--permission-mode','plan','--output-format','text']);
  assert.equal(launches[0].opts.cwd,ROOT);
  assert.equal(launches[0].opts.shell,false);
  assert.match(launches[0].child.input,/Inspect the layout/);
  assert.match(launches[0].child.input,/magpie-web-collab Skill/);
  assert.match(launches[0].child.input,/ego-browser/);
  launches[0].child.stdout.write('Finished');
  launches[0].child.emit('close',0);
  const status=JSON.parse(runner.status({harness:'claude',project:'TMN',taskId:r.taskId}));
  assert.equal(status.state,'completed');
  assert.equal(status.output,'Finished');
  assert.equal(status.processCompleted,true);
  assert.equal(status.taskOutcomeVerified,false);
});
test('DeepSeek Harness uses official dsh headless stdin only under native permissions',()=>{
  const {runner,launches}=setup({agentLaunchPermission:'native'});
  const r=JSON.parse(runner.launch({harness:'DeepSeek Harness',project:'TMN',prompt:'Write tests'}));
  assert.equal(r.harness,'dsh');
  assert.equal(launches[0].command,'dsh');
  assert.deepEqual(launches[0].args,['headless']);
  assert.ok(launches[0].child.input.includes('Write tests'));
  assert.match(launches[0].child.input,/ego-browser/);
  launches[0].child.emit('close',1);
  assert.equal(JSON.parse(runner.status({harness:'dsh',taskId:r.taskId})).state,'failed');
});
test('DeepSeek Harness refuses unverified read-only execution mode',()=>{
  const {runner,launches}=setup();
  assert.throws(()=>runner.launch({harness:'dsh',project:'TMN',prompt:'Inspect only'}),
    /no verified read-only mode/);
  assert.equal(launches.length,0);
});
test('explicit harness never substitutes another or touches unauthorized project',()=>{
  const {runner,launches}=setup({agentLaunchPermission:'native'});
  assert.throws(()=>runner.launch({harness:'gemini',project:'TMN',prompt:'Test'}),/no supported CLI launcher/);
  assert.throws(()=>runner.launch({harness:'claude',project:'Unapproved',prompt:'Test'}),/allowlist/);
  assert.throws(()=>runner.launch({harness:'dsh',project:'TMN',prompt:'Test',chatUrl:'https://evil.example/c/123456789'}),/chatgpt.com/);
  assert.throws(()=>runner.launch({harness:'opencode',project:'TMN',prompt:'No more OpenCode'}),/no supported CLI launcher/);
  assert.equal(launches.length,0);
});
test('running CLI task blocks a second start and can be cancelled',()=>{
  const {runner}=setup();
  const a=JSON.parse(runner.launch({harness:'claude',project:'TMN',prompt:'Task one'}));
  assert.throws(()=>runner.launch({harness:'dsh',project:'TMN',prompt:'Task two'}),/task is active/);
  assert.equal(JSON.parse(runner.cancel({harness:'claude',project:'TMN',taskId:a.taskId})).state,'cancelled');
  assert.throws(()=>runner.status({harness:'dsh',taskId:a.taskId}),/harness mismatch/);
});
test('a woken harness is told to adopt the provisioned mailbox session',()=>{
  const {runner,launches}=setup();
  const r=JSON.parse(runner.launch({harness:'claude',project:'TMN',prompt:'Continue',
    chatUrl:CHAT,peerMailbox:{sessionId:'session-abc',mode:'cli'}}));
  assert.equal(r.state,'running');
  const input=launches[0].child.input;
  assert.match(input,/PEER_MAILBOX_SESSION_ID: session-abc/);
  assert.match(input,/PEER_MAILBOX_MODE: cli/);
  assert.match(input,/resumeExisting:true/);
  assert.match(input,/Never invent a second mailbox session/);
  assert.match(input,/Do not ask the user or ChatGPT to confirm each step/);
  launches[0].child.emit('close',0);
});

test('a launch without a mailbox session says to register before polling',()=>{
  const {runner,launches}=setup();
  runner.launch({harness:'claude',project:'TMN',prompt:'Solo run'});
  assert.match(launches[0].child.input,/No Magpie mailbox session was provisioned/);
  assert.match(launches[0].child.input,/agent_register before polling/);
  launches[0].child.emit('close',0);
});

test('Windows invokes only a fixed shim command; task text stays in stdin',()=>{
  const calls=[];
  const spawn=(file,args,opts)=>{
    calls.push({file,args,opts});
    const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.input='';child.stdin.on('data',d=>child.input+=d.toString());
    child.kill=()=>{};
    calls.at(-1).child=child;
    return child;
  };
  const runner=createHarnessRunner({agentLaunchEnabled:true},{
    platform:'win32',env:{SystemRoot:'C:\\Windows'},spawn,projectRoots:()=>[{name:'TMN',root:'C:\\work\\TMN'}],runLimitMs:5000
  });
  const payload='Hello & whoami | exit';
  const r=JSON.parse(runner.launch({harness:'claude',project:'TMN',prompt:payload}));
  assert.equal(r.state,'running');
  assert.ok(calls[0].file.toLowerCase().endsWith('cmd.exe'));
  assert.doesNotMatch(calls[0].args.join(' '),/whoami|Hello/);
  assert.match(calls[0].child.input,/whoami/);
  calls[0].child.emit('close',0);
});

test('Windows invokes dsh headless without interpolating task text into cmd',()=>{
  const calls=[];
  const child=new EventEmitter();
  child.stdin=new PassThrough();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  child.input='';
  child.stdin.on('data',c=>{child.input+=c.toString('utf8');});
  child.kill=()=>{};
  const runner=createHarnessRunner({agentLaunchEnabled:true,agentLaunchPermission:'native'},{
    platform:'win32',env:{SystemRoot:'C:\\Windows'},
    projectRoots:()=>[{name:'TMN',root:'C:\\work\\TMN'}],
    spawn:(file,args,opts)=>{calls.push({file,args,opts});return child;},
    runLimitMs:5000,
  });
  const textInput='Review && do not run arbitrary shell commands';
  const r=JSON.parse(runner.launch({harness:'deepseekhsrness',project:'TMN',prompt:textInput}));
  assert.equal(r.harness,'dsh');
  assert.deepEqual(calls[0].args.slice(-1),['dsh headless']);
  assert.doesNotMatch(calls[0].args.join(' '),/arbitrary shell/);
  assert.match(child.input,/arbitrary shell/);
  child.emit('close',0);
});
