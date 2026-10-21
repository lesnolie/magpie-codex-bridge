/**
 * Detached installer launched ONLY after local Magpie options opt-in.
 * Uses the official Desktop-installed dsh command, never private Host tokens.
 * DSH Desktop must be fully quit; its plugin manager owns profile writes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile as run} from 'node:child_process';
import {promisify} from 'node:util';
const execFile=promisify(run);
const base=path.dirname(fileURLToPath(import.meta.url));
const status=path.join(base,'dsh-desktop-install-status.json');
const configFile=path.join(base,'dsh-desktop-inbox.json');
const bundle=path.join(base,'dsh-desktop-inbox-bundle');
const revision=process.env.MAGPIE_DSH_INSTALL_REVISION || 'unknown';

async function report(state,reason) {
  const payload={state,revision,updatedAt:new Date().toISOString(),
    ...(reason?{reason:String(reason).replace(/\s+/g,' ').slice(0,550)}:{})};
  const tmp=status+'.'+process.pid+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(payload,null,2));
  await fs.rename(tmp,status);
}
const psLiteral=value=>"'"+String(value).replace(/'/g,"''")+"'";
async function install(){
  const config=JSON.parse(await fs.readFile(configFile,'utf8'));
  if (config.enabled !== true) throw Error('DSH Desktop authorization was revoked');
  const {stdout}=await execFile('where.exe',['dsh.cmd'],{windowsHide:true,timeout:5000});
  const commands=stdout.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const candidate=commands[0];
  if(!candidate || !path.win32.isAbsolute(candidate))
    throw Error('Desktop dsh.cmd command not found. Use Desktop > Manage dsh Command > Install');
  const script="$ErrorActionPreference='Stop';"+
    "& "+psLiteral(candidate)+" plugin --profile desktop add "+psLiteral(bundle)+";"+
    "if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}";
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  // pnpm supports this official profile operation only while Desktop is quit.
  await execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{
    windowsHide:true,timeout:180000,maxBuffer:128*1024
  });
  const after=JSON.parse(await fs.readFile(configFile,'utf8'));
  if(after.enabled!==true) throw Error('Authorization revoked while installing');
}
try {
  await install();
  await report('installed');
} catch(error) {
  await report('install-failed',error?.stderr||error?.message||error);
}
