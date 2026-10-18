/**
 * One-shot *local page* diagnostic, NOT an MCP tool or HTTP endpoint.
 * Magpie's sandbox iframe can only write its OWN plugin options. A user click
 * stores a nonce; Magpie's documented options reload starts this trusted hook.
 * A separate Node worker outlives the plugin-host reload. No general command API.
 */
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile, rename, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {projectRoots} from './projects.mjs';
import {normalizeChatUrl, createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';
import {desktopPrompt, launchNativeCli} from './native-collab.mjs';
import {resolveCodexBinary, classifyCodexStderr} from './codex-tasks.mjs';
import {nodeBinary} from './remote-service.mjs';

const PAGE_FILE=fileURLToPath(new URL('../page/native-cli-test-status.js',import.meta.url));
const WORKER=fileURLToPath(new URL('../scripts/native-cli-test-runner.mjs',import.meta.url));
const LOCK='native-cli-test.lock';
const STATE='native-cli-test.json';
const REQUEST='native-cli-test-request.json';
const TIMEOUT=180000;
const LOCK_MAX_AGE=240000;
const ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function localTestFolder(env=process.env){
  return path.join(env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'MagpieLocalReview','native-cli-test');
}
function errorCategory(error){
  if(error?.killed||error?.code==='ETIMEDOUT')return 'timeout';
  if(error?.code==='ENOENT')return 'codex-not-found';
  if(error?.code==='EACCES'||error?.code==='EPERM')return 'access-denied';
  const classified=classifyCodexStderr(error?.stderr||'');
  if(classified?.includes('arguments incompatible'))return 'cli-arguments-incompatible';
  if(classified?.includes('authentication'))return 'authentication-failed';
  if(classified?.includes('model/provider'))return 'model-config-failed';
  if(classified?.includes('access denied'))return 'access-denied';
  if(classified?.includes('missing'))return 'codex-not-found';
  return 'cli-failed';
}
function cleanRequest(input,roots){
  if(!input||typeof input!=='object'||!ID.test(input.id||''))
    throw Error('Invalid one-time test request');
  if(typeof input.project!=='string'||input.project.length>96)
    throw Error('Invalid project');
  const project=roots.find(p=>p.name===input.project&&p.source==='codex');
  if(!project||!path.isAbsolute(project.root)||!existsSync(project.root))
    throw Error('Project is not registered in Codex Desktop');
  return {id:input.id,project:project.name,root:project.root,chatUrl:normalizeChatUrl(input.chatUrl)};
}
async function jsonFile(file){
  try{return JSON.parse(await readFile(file,'utf8'));}
  catch(e){if(e?.code==='ENOENT')return null;throw e;}
}
async function atomicJson(file,data){
  const temp=file+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});
  try{await rename(temp,file);}finally{await rm(temp,{force:true}).catch(()=>{});}
}
async function publish(dir,projects,target=PAGE_FILE){
  let state=await jsonFile(path.join(dir,STATE));
  if(state?.startedAt&&state.status==='running'&&Date.now()-Date.parse(state.startedAt)>LOCK_MAX_AGE){
    state={...state,status:'stale',category:'runner-not-reporting',finishedAt:new Date().toISOString()};
  }
  const publicState=state?{
    id:state.id,project:state.project,status:state.status,
    category:state.category||null,exitCode:Number.isInteger(state.exitCode)?state.exitCode:null,
    chatVerified:state.status==='chat_verified',
    startedAt:state.startedAt||null,finishedAt:state.finishedAt||null,
    // No local path, chat URL, prompt, tokens, stdout or stderr.
  }:null;
  const payload={projects:projects.map(x=>x.name),test:publicState,updatedAt:new Date().toISOString()};
  const js='globalThis.__magpieLocalCliTest='+JSON.stringify(payload)
    .replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029')+';\n';
  const temp=target+'.'+randomUUID()+'.tmp';
  await writeFile(temp,js,{mode:0o600,flag:'wx'});
  try{await rename(temp,target);}finally{await rm(temp,{force:true}).catch(()=>{});}
  return payload;
}
export async function publishLocalCliTestSnapshot({dir=localTestFolder(),roots=projectRoots(),target=PAGE_FILE}={}){
  await mkdir(dir,{recursive:true,mode:0o700});
  return publish(dir,roots,target);
}
function lockPath(dir){return path.join(dir,LOCK);}
async function release(dir,id){
  const lock=lockPath(dir);
  try{
    const owner=(await readFile(path.join(lock,'id'),'utf8')).trim();
    if(owner===id)await rm(lock,{recursive:true,force:true});
  }catch{}
}
async function claim(dir,id){
  const lock=lockPath(dir);
  try{await mkdir(lock,{mode:0o700});}
  catch(e){
    if(e?.code!=='EEXIST')throw e;
    const age=Date.now()-(await stat(lock)).mtimeMs;
    if(age>LOCK_MAX_AGE){
      // A hung old runner cannot be trusted. Abort instead of silently
      // starting another CLI on the same project.
      throw Error('A stale test lock needs local inspection; no new process started');
    }
    throw Error('Another local CLI test is running');
  }
  try{await writeFile(path.join(lock,'id'),id,{mode:0o600,flag:'wx'});}
  catch(e){await rm(lock,{recursive:true,force:true});throw e;}
}
export async function startLocalCliTest(options={},{
  dir=localTestFolder(),roots=projectRoots,
  getNode=nodeBinary,spawnWorker=spawn,target=PAGE_FILE,platform=process.platform
}={}){
  // Publishing a list and last status is safe even with Codex disabled.
  let listed=[];
  try{listed=roots();}catch{}
  await mkdir(dir,{recursive:true,mode:0o700});
  const request=options.nativeCliLocalTestRequest;
  if(!request){
    await publish(dir,listed,target).catch(()=>{});
    return {status:'idle'};
  }
  // This hook is called only after Magpie's *local* options.set + host reload.
  const old=await jsonFile(path.join(dir,STATE));
  if(old?.id===request.id){
    await publish(dir,listed,target).catch(()=>{});
    return {status:old.status,reused:true};
  }
  let selected;
  try{
    if(platform!=='win32')throw Error('Windows-only local test');
    if(options.codexEnabled!==true)throw Error('Codex disabled locally');
    selected=cleanRequest(request,listed);
  }catch{
    // Never print a potentially attacker-supplied URL or local path.
    const invalid={id:ID.test(request?.id||'')?request.id:'invalid',
      project:typeof request?.project==='string'?request.project.slice(0,96):'',
      status:'rejected',category:'invalid-request',finishedAt:new Date().toISOString()};
    await atomicJson(path.join(dir,STATE),invalid);
    await publish(dir,listed,target).catch(()=>{});
    return {status:'rejected'};
  }
  try{await claim(dir,selected.id);}
  catch{
    await publish(dir,listed,target).catch(()=>{});
    return {status:'busy'};
  }
  const state={id:selected.id,project:selected.project,status:'running',
    startedAt:new Date().toISOString()};
  try{
    // Keep request PRIVATE; only the trusted worker reads it from this folder.
    await atomicJson(path.join(dir,REQUEST),{id:selected.id,project:selected.project,chatUrl:selected.chatUrl});
    await atomicJson(path.join(dir,STATE),state);
    await publish(dir,listed,target).catch(()=>{});
    const node=await getNode();
    const child=spawnWorker(node,[WORKER,dir,selected.id],{
      detached:true,stdio:'ignore',windowsHide:true,shell:false,cwd:path.dirname(WORKER)
    });
    // The GUI host must not hold the test open, and no CLI output is logged.
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref?.();
    return {status:'running'};
  }catch{
    await atomicJson(path.join(dir,STATE),{...state,status:'spawn_failed',
      category:'node-or-runner-unavailable',finishedAt:new Date().toISOString()});
    await release(dir,selected.id);
    await publish(dir,listed,target).catch(()=>{});
    return {status:'spawn_failed'};
  }
}
export async function runLocalCliTestWorker(dir,id,{
  roots=projectRoots,cli=launchNativeCli,binary=resolveCodexBinary,
  sessions=()=>createChatSessions({projectRoots:roots}),target=PAGE_FILE
}={}){
  // An arbitrary command line cannot select an executable, command or root:
  // re-read and validate Codex Desktop's registered project at execution time.
  if(!ID.test(id||''))throw Error('Invalid worker ID');
  const lock=lockPath(dir);
  const owner=(await readFile(path.join(lock,'id'),'utf8')).trim();
  if(owner!==id)throw Error('Test lock mismatch');
  const req=await jsonFile(path.join(dir,REQUEST));
  const project=cleanRequest(req,roots());
  if(project.id!==id)throw Error('Test request mismatch');
  const taskId='localtest-'+id;
  const prompt=desktopPrompt({
    project:project.project,chatUrl:project.chatUrl,taskId,launchId:id,
    goal:'READ-ONLY diagnostic of Codex CLI and the installed magpie-codex-collab Skill. '+
      'Read project metadata only. Do NOT edit or generate project files, run builds, commit, publish, or create a PR. '+
      'Try the official Codex in-app browser to verify the EXACT target chat through Magpie MCP; '+
      'only then prepare/activate the chat binding locally. If the browser tool is unavailable, '+
      'report MAGPIE_BROWSER_UNAVAILABLE and do not claim a binding.'
  });
  const state={id,project:project.project,status:'running',startedAt:new Date().toISOString()};
  try{
    const result=await cli({binary:binary(),root:project.root,prompt,sandbox:'read-only',
      approval:'never',timeout:TIMEOUT});
    // The local Skill is authoritative for the chat session. CLI's exit code
    // or its LLM-produced text alone never constitutes binding proof.
    let verified=false;
    try{
      const active=sessions().status(project.project).active;
      verified=active?.taskId===taskId&&active?.url===project.chatUrl;
    }catch{}
    let reportedUnavailable=false;
    // Self-report is diagnostic only, not verification of the browser.
    if(typeof result?.stdout==='string')
      reportedUnavailable=result.stdout.includes('MAGPIE_BROWSER_UNAVAILABLE');
    await atomicJson(path.join(dir,STATE),{...state,
      status:verified?'chat_verified':reportedUnavailable?'browser_unavailable_reported':'cli_exited_unverified',
      category:verified?null:reportedUnavailable?'browser-unavailable-self-report':'browser-unverified',
      exitCode:0,finishedAt:new Date().toISOString()});
  }catch(e){
    await atomicJson(path.join(dir,STATE),{...state,
      status:errorCategory(e)==='timeout'?'timed_out':'cli_failed',
      category:errorCategory(e),exitCode:Number.isInteger(e?.code)?e.code:null,
      finishedAt:new Date().toISOString()});
  }finally{
    // Never return raw process output to the iframe or MCP.
    await rm(path.join(dir,REQUEST),{force:true}).catch(()=>{});
    await release(dir,id);
    await publish(dir,roots(),target).catch(()=>{});
  }
}
