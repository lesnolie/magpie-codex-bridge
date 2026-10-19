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
/**
 * Resolve the ONLY Codex Desktop registered workspace containing the native
 * Codex process' current directory. Never guess by a project label, another
 * conversation's state, or an arbitrary user-supplied path.
 */
export function resolveCurrentProject(roots,workspace=process.cwd()){
  if(typeof workspace!=='string'||!path.isAbsolute(workspace))return null;
  let actual;
  try{
    actual=fs.realpathSync(workspace);
    if(!fs.statSync(actual).isDirectory())return null;
  }catch{return null;}
  const matches=roots.filter(p=>{
    if(p?.source!=='codex'||typeof p.root!=='string'||!path.isAbsolute(p.root))return false;
    let root;
    try{root=fs.realpathSync(p.root);}catch{return false;}
    const relative=path.relative(root,actual);
    return relative==='' || (relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));
  }).sort((a,b)=>b.root.length-a.root.length);
  if(matches.length>1&&matches[0].root.length===matches[1].root.length)
    fail('Ambiguous Codex workspace; select a unique registered workspace');
  return matches[0]||null;
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
    nativeThreadLinked:Boolean(s.nativeThreadId&&s.linkedRoot===p.root),
    launch:s.launch?{launchId:s.launch.launchId,taskId:s.launch.taskId,status:s.launch.status,transport:s.launch.transport,requestedAt:s.launch.requestedAt,chatUrl:s.launch.chatUrl,
      failureCategory:s.launch.failureCategory||null,
      failureStage:s.launch.failureStage||null,failureCode:s.launch.failureCode||null,
      exitStatus:s.launch.exitStatus??null,failureKind:s.launch.failureKind||null,
      recoveredFrom:s.launch.recoveredFrom||null,
      autoSubmit:s.launch.autoSubmit||'disabled'}:null,
    browserControl:'not-verified',
    note:'Requesting transfer does not activate it. A native Codex browser must verify the target and activate locally.'};
}
export function createChatSessions({projectRoots=nativeCodexProjectRoots,folder=sessionFolder(),
  currentWorkspace=()=>process.cwd()}={}){
  function allowed(name,requireLocalWorkspace=false){
    const projects=projectRoots();
    const workspace=resolveCurrentProject(projects,currentWorkspace());
    const automatic=name===undefined||name===null||name===''||name==='auto';
    const p=automatic?workspace:projects.find(x=>x.name===name&&x.source==='codex');
    if(!p||!path.isAbsolute(p.root))
      fail(automatic?'No unique Codex Desktop project matches the current workspace':
        'Project is not registered in Codex Desktop');
    if(requireLocalWorkspace&&(!workspace||workspace.root!==p.root))
      fail('Codex workspace mismatch; cannot bind another project from this Desktop session');
    return p;
  }
  // Remote callers cannot inspect the active Codex Desktop window. Resolve
  // automatically only when an exact ChatGPT URL has ONE locally verified,
  // workspace-pinned native thread; otherwise require Desktop initiation.
  function findLinkedProject({chatUrl}={}){
    const url=normalizeChatUrl(chatUrl),matches=[];
    for(const p of projectRoots()){
      if(p?.source!=='codex'||!path.isAbsolute(p.root))continue;
      const s=load(filename(p,folder));
      if(s.active?.url===url&&s.nativeThreadId&&s.linkedRoot===p.root)
        matches.push(p.name);
    }
    if(matches.length>1)fail('Multiple native Codex workspaces are bound to this chat; project confirmation required');
    return matches[0]||null;
  }
  function status(project){const p=allowed(project);return view(p,load(filename(p,folder)));}
  /** Local code callback only. Sensitive goal and path must never be included
   * in a directly serialized MCP result. This is a read-only snapshot.
   */
  function inspectLaunch(project,inspector){
    if(typeof inspector!=='function')fail('Local launch inspector required');
    const p=allowed(project),s=load(filename(p,folder)),launch=s.launch;
    if(!launch)return null;
    return inspector({project:p.name,root:p.root,launch:{
      transport:launch.transport,goal:launch.goal,chatUrl:launch.chatUrl,
      taskId:launch.taskId,launchId:launch.launchId,status:launch.status
    }});
  }
  function request({project,taskId,url,reason}={},localNewTask=false){
    const p=allowed(project),file=filename(p,folder);
    return locked(file,()=>{
      const s=load(file),id=taskId?taskName(taskId):s.active?.taskId;
      if(!id)fail('taskId required for first binding');
      // Fence off delayed responses from a superseded Desktop prompt.
      if(!s.active&&s.launch?.transport==='desktop'&&
         s.launch.taskId!==id&&
         ['prepared','dispatching','opened_unconfirmed','acknowledged'].includes(s.launch.status))
        fail('Stale Desktop launch task; cannot bind superseded task');
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
    const p=allowed(project,true),file=filename(p,folder);
    if(verifiedProject!==p.name)fail('Native Codex must verify connected MCP project name');
    if(typeof requestId!=='string'|| !/^[a-f0-9-]{36}$/i.test(requestId))fail('Invalid requestId');
    const url=normalizeChatUrl(observedUrl);
    return locked(file,()=>{
      const s=load(file),q=s.pending;
      if(!q||q.requestId!==requestId)fail('Pending transfer not found');
      if(q.baseGeneration!==s.generation)fail('Stale transfer; prepare again');
      if(q.url&&q.url!==url)fail('Browser-observed chat URL differs from requested chat');
      const old=s.active?.url||null;
      // A new conversation or fresh Desktop composer may create a new Codex
      // thread. Never keep a stale thread ID that would queue to the wrong agent.
      if(old!==url || (s.launch?.taskId===q.taskId && s.launch.transport==='desktop'))
        {s.nativeThreadId=null;s.linkedRoot=null;}
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
  // Remote invocation may stage a future native Codex start, but cannot
  // activate chat binding. Idempotency prevents duplicate launches on retry.
  // A different explicit new task may supersede an unbound Desktop ticket
  // after its safety window; identical requests never auto-retry.
  const ORPHAN_DESKTOP_TTL_MS = 10 * 60 * 1000;
  function prepareLaunch({project,goal,chatUrl,taskId}={}){
    const p=allowed(project),file=filename(p,folder);
    const normalized=normalizeChatUrl(chatUrl);
    if(typeof goal!=='string'||!goal.trim()||goal.length>1200||
       /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(goal))
      fail('Goal must contain 1-1200 safe characters');
    return locked(file,()=>{
      const s=load(file),clean=goal.trim();
      if(s.launch&&['prepared','dispatching','opened_unconfirmed','queued_unconfirmed','dispatch_failed'].includes(s.launch.status)){
        const previous=s.launch;
        const identical=previous.chatUrl===normalized&&previous.goal===clean&&
          (!taskId||taskId===previous.taskId);
        if(identical)
          return {...view(p,s),reused:true,localRoot:p.root,nativeThreadId:s.nativeThreadId||null};
        const age=Date.now()-Date.parse(previous.updatedAt||previous.requestedAt);
        const newTaskIdentity=!taskId||taskId!==previous.taskId;
        const orphaned=previous.status==='opened_unconfirmed'&&previous.transport==='desktop'&&
          Number.isFinite(age)&&age>=ORPHAN_DESKTOP_TTL_MS&&newTaskIdentity&&
          !s.active&&!s.pending&&!s.nativeThreadId;
        if(!orphaned)
          fail('A different native Codex launch is pending; resolve it locally before starting another');
        // Preserve only safe metadata about the superseded ticket.
        s.lastSupersededLaunch={launchId:previous.launchId,taskId:previous.taskId,
          at:new Date().toISOString(),reason:'unbound-desktop-timeout'};
      }
      if(s.active&&s.active.url!==normalized&&s.checkpoint?.protocolState!=='DONE'&&
         s.checkpoint?.protocolState!=='BLOCKED')
        fail('Active chat differs; switch the current task using verified chat handoff first');
      if(s.active&&s.checkpoint&& !['DONE','BLOCKED'].includes(s.checkpoint.protocolState))
        fail('A different task is already active; finish or block it before starting again');
      const id=taskId?taskName(taskId):'native-'+randomUUID();
      const matchingThread=Boolean(s.nativeThreadId&&s.linkedRoot===p.root&&s.active?.url===normalized);
      s.launch={launchId:randomUUID(),taskId:id,goal:clean,chatUrl:normalized,
        status:'prepared',transport:matchingThread?'queue':'desktop',
        requestedAt:new Date().toISOString()};
      // This does NOT change s.active or start execution.
      save(file,s);
      return {...view(p,s),reused:false,localRoot:p.root,
        nativeThreadId:matchingThread?s.nativeThreadId:null};
    });
  }
  function updateLaunch({project,launchId,status,failureCategory,failureStage,failureCode,exitStatus,failureKind}={}){
    const p=allowed(project),file=filename(p,folder);
    if(!['dispatching','opened_unconfirmed','queued_unconfirmed','dispatch_failed',
          'acknowledged','blocked'].includes(status))fail('Invalid launch status');
    return locked(file,()=>{
      const s=load(file);
      if(s.launch?.launchId!==launchId)fail('Launch receipt no longer matches');
      const transitions={
        prepared:['dispatching','dispatch_failed'],
        dispatching:['opened_unconfirmed','queued_unconfirmed','dispatch_failed'],
        opened_unconfirmed:['acknowledged','blocked'],
        queued_unconfirmed:['acknowledged','blocked'],
        dispatch_failed:[],acknowledged:[],blocked:[]
      };
      if(!transitions[s.launch.status]?.includes(status))fail('Invalid launch status transition');
      s.launch.status=status;
      if(status==='dispatch_failed'){
        // Safe enumerated diagnosis; never retain raw stderr, protocol URLs or paths.
        const permitted=new Set(['launcher-not-found','access-denied','launcher-timeout',
          'protocol-handler-error','command-failed','invalid-uri','unexpected-error',
          'launcher-argument-too-long','launcher-output-overflow','url-too-long',
          'invalid-project-root','invalid-prompt','uri-construction-error']);
        s.launch.failureCategory=permitted.has(failureCategory)?failureCategory:'unexpected-error';
        s.launch.failureStage=['building-uri','windows-launcher'].includes(failureStage)?failureStage:null;
        const codes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','E2BIG','ENAMETOOLONG',
          'ERR_CHILD_PROCESS_STDIO_MAXBUFFER','ERR_CHILD_PROCESS_FAILED',
          'DESKTOP_URL_TOO_LONG','DESKTOP_BAD_ROOT','DESKTOP_BAD_PROMPT',
          'DESKTOP_URI_ENCODING_FAILED']);
        s.launch.failureCode=(typeof failureCode==='string'&&
          (codes.has(failureCode)||/^\d{1,3}$/.test(failureCode)))?failureCode:null;
        s.launch.exitStatus=(Number.isInteger(exitStatus)&&exitStatus>=0&&exitStatus<=255)?exitStatus:null;
        s.launch.failureKind=['Error','TypeError','RangeError','SystemError','AbortError'].includes(failureKind)
          ?failureKind:'unknown';
      }else{
        delete s.launch.failureCategory;delete s.launch.failureStage;
        delete s.launch.failureCode;delete s.launch.exitStatus;delete s.launch.failureKind;
      }
      s.launch.updatedAt=new Date().toISOString();
      save(file,s);return view(p,s);
    });
  }
  function recordAutoSubmit({project,launchId,result}={}){
    const p=allowed(project),record=filename(p,folder);
    const allowedResults=new Set(['disabled','not-verified','invoked-unconfirmed','unsupported-platform',
      'window-not-found','composer-not-readable','composer-not-matched','send-control-not-found',
      'send-control-disabled','send-invoke-unavailable','ambiguous-target','uia-error',
      'codex-process-not-found','desktop-session-mismatch','desktop-window-unavailable',
      'desktop-window-inaccessible']);
    if(!allowedResults.has(result))fail('Invalid Desktop submit result');
    return locked(record,()=>{
      const s=load(record);
      if(s.launch?.launchId!==launchId||s.launch.status!=='opened_unconfirmed')
        fail('Auto-submit receipt no longer matches a current Desktop launch');
      s.launch.autoSubmit=result;
      s.launch.updatedAt=new Date().toISOString();
      save(record,s);return view(p,s);
    });
  }
  // A one-time, locally authorized recovery for a confirmed failed dispatch.
  // Requires all four exact binding identifiers and resets ONLY dispatch_failed;
  // a request still in-flight, queued, opened or acknowledged is never retried.
  function recoverLaunch({project,launchId,taskId,chatUrl,confirm}={}){
    if(confirm!==true&&confirm!=='true')
      fail('Local launch recovery requires --confirm true');
    const p=allowed(project),file=filename(p,folder),url=normalizeChatUrl(chatUrl);
    if(typeof launchId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(launchId))
      fail('Expected original launch UUID');
    const safeTask=taskName(taskId);
    return locked(file,()=>{
      const s=load(file),launch=s.launch;
      if(!launch||launch.launchId!==launchId||launch.taskId!==safeTask||
         launch.chatUrl!==url||launch.status!=='dispatch_failed')
        fail('No matching failed launch; recovery refused');
      if(launch.transport!=='desktop')
        fail('Only failed native Desktop launch tickets may be recovered');
      if(s.active&&s.active.url!==url&&
         !['DONE','BLOCKED'].includes(s.checkpoint?.protocolState))
        fail('Different active chat is still in progress');
      // Issue a fresh nonce. Old launch prompts/receipts are invalid after this.
      launch.launchId=randomUUID();
      launch.status='prepared';
      delete launch.failureCategory;
      delete launch.failureStage;delete launch.failureCode;
      delete launch.exitStatus;delete launch.failureKind;
      launch.requestedAt=new Date().toISOString();
      launch.recoveredFrom=launchId;
      save(file,s);
      return {...view(p,s),recovered:true};
    });
  }
  // Invoked only in the local Skill CLI after a browser-visible workspace check.
  function linkThread({project,taskId,generation,threadId}={}){
    const p=allowed(project,true),file=filename(p,folder);
    if(typeof threadId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId))
      fail('Native Codex thread UUID required');
    return locked(file,()=>{
      const s=load(file);
      if(!s.active||s.active.taskId!==taskName(taskId)||
         s.active.generation!==Number(generation))fail('Stale chat or task binding');
      s.nativeThreadId=threadId;
      s.linkedRoot=p.root;
      if(s.launch?.taskId===taskId&&['opened_unconfirmed','queued_unconfirmed'].includes(s.launch.status))
        s.launch.status='acknowledged';
      save(file,s);return view(p,s);
    });
  }
  // Repair a mistaken legacy association without editing project source or
  // changing the verified chat. Requires the exact registered UUID as proof
  // of which association the user intends to clear.
  function unlinkThread({project,threadId}={}){
    const p=allowed(project),file=filename(p,folder);
    if(typeof threadId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId))
      fail('Expected native Codex thread UUID required');
    return locked(file,()=>{
      const s=load(file);
      if(s.nativeThreadId!==threadId)fail('Thread ID mismatch; cannot clear another association');
      delete s.nativeThreadId;
      delete s.linkedRoot;
      // Do not change active chat or any queued launch receipt.
      save(file,s);
      return {...view(p,s),unlinked:true};
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
  return {status,request,activate,checkpoint,handoff,prepareLaunch,updateLaunch,recordAutoSubmit,recoverLaunch,linkThread,unlinkThread,findLinkedProject,inspectLaunch};
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
      command==='handoff'?api.handoff(opts):
      command==='link-thread'?api.linkThread(opts):
      command==='unlink-thread'?api.unlinkThread(opts):
      command==='recover-launch'?api.recoverLaunch(opts):null;
    if(!result)fail('Usage: node chat-session.mjs status|prepare|activate|checkpoint|handoff|link-thread|unlink-thread|recover-launch [--project NAME|auto] [--task-id ID] [--url HTTPS] [--new-task true] [--request-id UUID] [--observed-url HTTPS] [--verified-project NAME] [--thread-id UUID] [--launch-id UUID] [--chat-url HTTPS] [--confirm true]');
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }catch(e){process.stderr.write('Chat handoff: '+e.message+'\n');process.exitCode=1;}
}
