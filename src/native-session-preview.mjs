/**
 * Read-only local snapshot for Magpie's Project Review UI.
 * No URLs, workspace paths, thread IDs, prompts or secret fields are exposed.
 * This is a point-in-time snapshot, refreshed only when the plugin reloads.
 */
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {projectRoots} from './projects.mjs';
import {createChatSessions} from '../skills/magpie-codex-collab/chat-session.mjs';

const DEFAULT_TARGET=fileURLToPath(new URL('../page/native-session-preview.js',import.meta.url));
export async function publishNativeSessionPreview({
  roots=()=>projectRoots(),sessions=null,target=DEFAULT_TARGET
}={}){
  let registered=[],available=true;
  try{
    const entries=roots();
    if(!Array.isArray(entries))throw Error('Codex registry unavailable');
    registered=entries.filter(p=>p?.source==='codex'&&typeof p.name==='string'&&p.name.length<=96).slice(0,80);
  }catch{available=false;}
  let chat=sessions;
  try{chat??=createChatSessions({projectRoots:roots});}catch{available=false;}
  const projects=[];
  for(const p of registered){
    let bound=false,hasChat=false;
    try{
      const state=chat.status(p.name);
      // Legacy bindings lack workspace verification and intentionally do not
      // count as verified. This mirrors the native queue gate.
      bound=state.nativeThreadLinked===true&&Boolean(state.active);
      hasChat=Boolean(state.active);
    }catch{ /* A corrupt record cannot claim a verified binding. */ }
    projects.push({name:p.name,bound,hasChat});
  }
  const payload={version:1,available,updatedAt:new Date().toISOString(),projects};
  const encoded=JSON.stringify(payload).replaceAll('<','\\u003c')
    .replaceAll('\\u2028','\\u2028').replaceAll('\\u2029','\\u2029');
  const output='globalThis.__magpieNativeSessionPreview='+encoded+';\n';
  await mkdir(path.dirname(target),{recursive:true});
  const tmp=target+'.'+randomUUID()+'.tmp';
  try{await writeFile(tmp,output,{mode:0o600,flag:'wx'});await rename(tmp,target);}
  finally{await rm(tmp,{force:true}).catch(()=>{});}
  return payload;
}
