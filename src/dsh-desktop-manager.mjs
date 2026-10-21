/**
 * One-plugin DSH Desktop setup. Magpie locally controls the bundled receiver;
 * no ChatGPT/MCP call can authorize installation or choose a Session.
 *
 * Only an explicit, locally saved Magpie option can stage an installation.
 * DSH Desktop must be fully quit for its documented profile management CLI.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises';
import { nodeBinary } from './remote-service.mjs';
import { normalizePeerChatUrl } from './peer-messages.mjs';

const BUNDLE = ['index.mjs','package.json','cordis.patch.yml'];
export const DSH_DESKTOP_INSTALL_REVISION = '0.4.34-alpha.1';
const installedPath = name => new URL('../integrations/dsh-desktop-inbox/' + name, import.meta.url);

export function desktopPaths(env = process.env) {
  const root = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(root,'MagpieLocalReview');
  return { base, config: path.join(base,'dsh-desktop-inbox.json'),
    bundle: path.join(base,'dsh-desktop-inbox-bundle'),
    installer: path.join(base,'dsh-desktop-installer.mjs'),
    status: path.join(base,'dsh-desktop-install-status.json') };
}

export function validateDesktopOptions(options={}) {
  if (options.dshDesktopInboxEnabled !== true) return { enabled: false };
  const project = String(options.dshDesktopProject || '').trim();
  const nativeSessionId = String(options.dshDesktopNativeSessionId || '').trim();
  if (!project || project.length > 100 || /[\r\n<>]/.test(project))
    throw Error('DSH Desktop requires a locally configured project label');
  if (!nativeSessionId || nativeSessionId.length > 160 || /[\s<>]/.test(nativeSessionId))
    throw Error('DSH Desktop requires the native Session ID (not the Magpie mailbox ID)');
  const chatUrl = normalizePeerChatUrl(options.dshDesktopChatUrl);
  return { enabled:true, nativeSessionId, project, chatUrl, pollIntervalMs:3000 };
}

async function writeAtomic(target, value) {
  const temp = target + '.' + process.pid + '.tmp';
  try {
    await writeFile(temp, value, {mode:0o600});
    await rename(temp, target);
  } finally { await unlink(temp).catch(()=>{}); }
}
async function readStatus(file) {
  try { return JSON.parse(await readFile(file,'utf8')); }
  catch(e) { if(e.code==='ENOENT') return null; throw e; }
}

/**
 * Called by Magpie plugin initialization after local options.set. Installation
 * runs in a detached task, not inside the short-lived remote MCP request.
 * This is not callable as a remote tool.
 */
export async function reconcileDshDesktop(options={}, {
  env=process.env, platform=process.platform, findNode=nodeBinary,
  launch=(file,args,opts)=>spawn(file,args,opts),
}={}) {
  if (platform !== 'win32') return {state:'unsupported-platform'};
  const p = desktopPaths(env);
  await mkdir(p.base,{recursive:true});
  if (options.dshDesktopInboxEnabled !== true) {
    // Revocation takes effect immediately: receiver checks the file on each
    // poll, even if Desktop remains open.
    await unlink(p.config).catch(e=>{if(e.code!=='ENOENT') throw e;});
    return {state:'disabled'};
  }
  const config=validateDesktopOptions(options);
  const existing=await readStatus(p.status);
  await mkdir(p.bundle,{recursive:true});
  for(const name of BUNDLE) {
    await copyFile(fileURLToPath(installedPath(name)),path.join(p.bundle,name));
  }
  await writeAtomic(p.config,JSON.stringify(config,null,2)+'\n');
  const workerSource=fileURLToPath(new URL('../scripts/dsh-desktop-installer.mjs',import.meta.url));
  await copyFile(workerSource,p.installer);

  if (existing?.state==='installed' && existing?.revision===DSH_DESKTOP_INSTALL_REVISION)
    return {state:'installed', restartDesktop:true};
  // Multiple plugin reloads cannot start simultaneous pnpm operations.
  if (existing?.state==='installing' && existing?.revision===DSH_DESKTOP_INSTALL_REVISION &&
      Date.now()-Date.parse(existing.updatedAt)<180000)
    return {state:'installing'};

  // Reserve before spawning so concurrent option refreshes fail closed.
  await writeAtomic(p.status,JSON.stringify({state:'installing',
    revision:DSH_DESKTOP_INSTALL_REVISION,updatedAt:new Date().toISOString()},null,2));
  try {
    const node = await findNode(env);
    await new Promise((resolve,reject)=>{
      const child=launch(node,[p.installer],{
        cwd:p.base,detached:true,stdio:'ignore',windowsHide:true,shell:false,
        env:{...env,MAGPIE_DSH_INSTALL_REVISION:DSH_DESKTOP_INSTALL_REVISION}
      });
      child.once('error',reject);
      child.once('spawn',()=>{child.unref?.();resolve();});
    });
    return {state:'installing',restartDesktop:true};
  } catch (error) {
    const reason=String(error?.message||error).slice(0,400);
    await writeAtomic(p.status,JSON.stringify({state:'install-failed',reason,
      revision:DSH_DESKTOP_INSTALL_REVISION,updatedAt:new Date().toISOString()}));
    return {state:'install-failed',reason};
  }
}

export async function dshDesktopSetupStatus(env=process.env) {
  const p=desktopPaths(env);
  const value=await readStatus(p.status);
  return value || {state:'not-installed'};
}
