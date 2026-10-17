#!/usr/bin/env node
/** Local-only chat handoff CLI, bundled with the Codex Skill.
 * Remote MCP can only REQUEST a change. Native Codex verifies the new chat
 * and commits the switch locally. No browser or network access in this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function sessionFolder() {
  if (process.env.MAGPIE_CHAT_SESSION_DIR) return path.resolve(process.env.MAGPIE_CHAT_SESSION_DIR);
  const base=process.platform==='win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'))
    : (process.env.XDG_STATE_HOME || path.join(os.homedir(),'.local','state'));
  return path.join(base,'MagpieLocalReview','chat-sessions');
}
function fail(message) {throw new Error(message);}
function small(v,n=500){return typeof v==='string' ? v.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,n):'';}
function taskName(name) {
  if(typeof name!=='string'|| !/^[a-zA-Z0-9_.:-]{2,96}$/.test(name))fail('Invalid taskId');
  return name;
}
export function normalizeChatUrl(value) {
  if(typeof value!=='string'||value.length>600)fail('Chat URL is required');
  let u;
  try{u=new URL(value);}catch{fail('Invalid ChatGPT conversation URL');}
  if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.username||u.password||u.port||u.search||u.hash||
    !/^\/(?:g\/g-p-[\w-]+\/)?c\/[\w-]{8,}\/?$/.test(u.pathname))
    fail('Expected a chatgpt.com conversation URL, never a project homepage or outside URL');
  return 'https://chatgpt.com'+u.pathname.replace(/\/$/,'');
}
export function nativeCodexProjectRoots(){
  const file=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'.codex-global-state.json');
  let data;
  try{data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
  catch{fail('Codex Desktop project registry unavailable');}
  const entries=data?.['local-projects'];
  if(!entries||typeof entries!=='object'||Array.isArray(entries))fail('Codex Desktop has no local-projects registry');
  const roots=[],used=new Set();
  for(const e of Object.values(entries).slice(0,100)){
    if(!Array.isArray(e?.rootPaths))continue;
    const folders=e.rootPaths.slice(0,8);
    for(const folder of folders){
      if(typeof folder!=='string'||!path.isAbsolute(folder))continue;
      let root;
      try{
        if(fs.lstatSync(folder).isSymbolicLink())continue;
        root=fs.realpathSync(folder);
        if(!fs.statSync(root).isDirectory()||root===path.parse(root).root)continue;
      }catch{continue;}
      const label=typeof e.name==='string'&&e.name.trim()?e.name.trim().slice(0,96):path.basename(root);
      const proposed=folders.length===1?label:label+' / '+path.basename(root);
      let name=proposed;
      for(let i=2;used.has(name);i++)name=proposed+' ('+i+')';
      used.add(name);roots.push({name,root,source:'codex'});
    }
  }
  return roots;
}
function filename(p,folder){
  return path.join(folder,createHash('sha256').update(p.root).digest('hex').slice(0,40)+'.json');
}
function load(file){
  try{
    const content=fs.readFileSync(file,'utf8');
    if(content.length>12000)fail('Oversized session record');
    const v=JSON.parse(content);
    if(v?.version!==1)fail('Unsupported session record version');
    return v;
  }catch(e){
    if(e.code==='ENOENT')return {version:1,generation:0,active:null,pending:null,checkpoint:null};
    throw e;
  }
}
function save(file,data){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{
    fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
    fs.renameSync(tmp,file);
  }finally{try{fs.unlinkSync(tmp);}catch{}}
}
function locked(file,fn){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const key=file+'.lock';
  let got=false;
  for(let i=0;i<80;i++){
    try{fs.mkdirSync(key,{mode:0o700});got=true;break;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      try{if(Date.now()-fs.statSync(key).mtimeMs>30000)fs.rmdirSync(key);}catch{}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
    }
  }
  if(!got)fail('Session record is busy');
  try{return fn();}finally{fs.rmdirSync(key);}
}
function view(p,s){
  return {project:p.name,active:s.active||null,
    pending:s.pending?{requestId:s.pending.requestId,taskId:s.pending.taskId,
      url:s.pending.url,requestedAt:s.pending.requestedAt}:null,
    checkpoint:s.checkpoint||null,stateGeneration:s.generation,
    browserControl:'not-verified',
    note:'Requesting transfer does not activate it. A native Codex browser must verify the target and activate locally.'};
}
export function createChatSessions({projectRoots=nativeCodexProjectRoots,folder=sessionFolder()}={}){
  function allowed(name){
    const p=typeof name==='string'?projectRoots().find(x=>x.name===name&&x.source==='codex'):null;
    if(!p||!path.isAbsolute(p.root))fail('Project is not registered in Codex Desktop');
    return p;
  }
  function status(project){const p=allowed(project);return view(p,load(filename(p,folder)));}
  function request({project,taskId,url,reason}={},localNewTask=false){
    const p=allowed(project),file=filename(p,folder);
    return locked(file,()=>{
      const s=load(file),id=taskId?taskName(taskId):s.active?.taskId;
      if(!id)fail('taskId required for first binding');
      if(s.active&&s.active.taskId!==id){
        if(!localNewTask || !['DONE','BLOCKED'].includes(s.checkpoint?.protocolState))
          fail('Different active task; only a completed/blocked task can be replaced locally');
      }
      const target=url?normalizeChatUrl(url):null;
      if(s.pending&&s.pending.taskId===id&&s.pending.url===target)
        return {...view(p,s),accepted:true};
      s.pending={requestId:randomUUID(),taskId:id,url:target,
        baseGeneration:s.generation,reason:small(reason,160),requestedAt:new Date().toISOString()};
      save(file,s);return {...view(p,s),accepted:true};
    });
  }
  function activate({project,requestId,observedUrl,verifiedProject}={}){
    const p=allowed(project),file=filename(p,folder);
    if(verifiedProject!==p.name)fail('Native Codex must verify connected MCP project name');
    if(typeof requestId!=='string'|| !/^[a-f0-9-]{36}$/i.test(requestId))fail('Invalid requestId');
    const url=normalizeChatUrl(observedUrl);
    return locked(file,()=>{
      const s=load(file),q=s.pending;
      if(!q||q.requestId!==requestId)fail('Pending transfer not found');
      if(q.baseGeneration!==s.generation)fail('Stale transfer; prepare again');
      if(q.url&&q.url!==url)fail('Browser-observed chat URL differs from requested chat');
      const old=s.active?.url||null;
      s.generation+=1;s.active={url,taskId:q.taskId,generation:s.generation,
        activatedAt:new Date().toISOString()};
      s.pending=null;
      if(!s.checkpoint||s.checkpoint.taskId!==s.active.taskId)
        s.checkpoint={taskId:s.active.taskId,iteration:0,protocolState:'INIT',
          waitingFor:'none',goal:'',progress:'',issues:'',nextStep:''};
      save(file,s);return {...view(p,s),activated:true,previousUrl:old};
    });
  }
  function checkpoint({project,taskId,generation,iteration,protocolState,waitingFor,goal,progress,issues,nextStep}={}){
    const p=allowed(project),file=filename(p,folder);
    if(!['INIT','PLAN_RECEIVED','EXECUTING','EXECUTED_LOCAL','EXECUTED_SENT','DONE','BLOCKED'].includes(protocolState)||
      !['none','GPT_PLAN','GPT_REVIEW','USER'].includes(waitingFor))fail('Invalid state');
    const n=Number(iteration);
    if(!Number.isSafeInteger(n)||n<0||n>500)fail('Invalid iteration');
    return locked(file,()=>{
      const s=load(file);
      if(!s.active||s.active.taskId!==taskName(taskId)||s.active.generation!==Number(generation))
        fail('Stale task or chat; cannot overwrite checkpoint');
      s.checkpoint={taskId,iteration:n,protocolState,waitingFor,
        goal:small(goal,500),progress:small(progress,800),issues:small(issues,450),
        nextStep:small(nextStep,450),updatedAt:new Date().toISOString()};
      save(file,s);return {...view(p,s),saved:true};
    });
  }
  function handoff({project,taskId}={}){
    const s=status(project),a=s.active,c=s.checkpoint;
    if(!a)fail('No active chat');
    if(taskId&&a.taskId!==taskId)fail('Task mismatch');
    const lines=['[MAGPIE HANDOFF]','PROJECT: '+s.project,'TASK_ID: '+a.taskId,
      'ITERATION: '+(c?.iteration??0),'STATE: '+(c?.protocolState||'INIT'),
      'WAITING_FOR: '+(c?.waitingFor||'none'),
      'GOAL: '+(c?.goal||'(read current code via MCP)'),
      'PROGRESS: '+(c?.progress||'(independently review Git diff via MCP)'),
      'ISSUES: '+(c?.issues||'none recorded'),
      'NEXT_STEP: '+(c?.nextStep||'Verify workspace through MCP before continuing'),
      'Use only the verified Magpie workspace connector. Never re-execute completed iterations.'];
    return {project:s.project,active:a,checkpoint:c,handoff:lines.join('\n')};
  }
  return {status,request,activate,checkpoint,handoff};
}
function argsOf(argv){
  const [command,...rest]=argv,opts={};
  for(let i=0;i<rest.length;i++){
    const key=rest[i];
    if(!key.startsWith('--')||!rest[i+1]||rest[i+1].startsWith('--'))fail('Expected --key value');
    opts[key.slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=rest[++i];
  }
  return {command,opts};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const {command,opts}=argsOf(process.argv.slice(2)),api=createChatSessions();
    const result=command==='status'?api.status(opts.project):
      command==='prepare'?api.request(opts,opts.newTask==='true'):
      command==='activate'?api.activate(opts):
      command==='checkpoint'?api.checkpoint(opts):
      command==='handoff'?api.handoff(opts):null;
    if(!result)fail('Usage: node chat-session.mjs status|prepare|activate|checkpoint|handoff --project NAME [--task-id ID] [--url HTTPS] [--new-task true] [--request-id UUID] [--observed-url HTTPS] [--verified-project NAME]');
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(e){process.stderr.write('Chat handoff: '+e.message+'\n');process.exitCode=1;}
}
