/**
 * Resolve only native Codex executables. Never execute npm .cmd/.ps1 shims
 * or invoke an untrusted shell. Local options take precedence over discovery.
 */
import path from 'node:path';
import {statSync,readdirSync} from 'node:fs';

function binaryError(code,message){
  const error=new Error(message);
  error.code=code;
  return error;
}
export function resolveCodexBinary(options={},runtime={}){
  const platform=runtime.platform||process.platform;
  const arch=runtime.arch||process.arch;
  const env=runtime.env||process.env;
  const p=platform==='win32'?path.win32:path;
  const isFile=runtime.isFile||((file)=>{
    try{return statSync(file).isFile();}catch{return false;}
  });
  const readDirs=runtime.readDirs||((dir)=>{
    try{return readdirSync(dir,{withFileTypes:true})
      .filter(x=>x.isDirectory()).map(x=>x.name);}catch{return [];}
  });
  if(options.codexExecutable!==undefined&&options.codexExecutable!==null&&
     String(options.codexExecutable).trim()!==''){
    const chosen=String(options.codexExecutable).trim();
    if(!p.isAbsolute(chosen)||
       (platform==='win32'&&!/\.exe$/i.test(chosen))||
       /[\r\n\0]/.test(chosen))
      throw binaryError('CODEX_BINARY_INVALID',
        'Codex executable must be an absolute native executable path');
    if(!isFile(chosen))
      throw binaryError('CODEX_BINARY_NOT_FOUND',
        'Configured Codex executable is not an existing regular file');
    return chosen;
  }
  if(platform!=='win32')return 'codex';
  const names=arch==='arm64'
    ?[['win32-arm64','aarch64-pc-windows-msvc'],['win32-x64','x86_64-pc-windows-msvc']]
    :[['win32-x64','x86_64-pc-windows-msvc']];
  const npmRoots=[env.npm_config_prefix,env.APPDATA&&p.join(env.APPDATA,'npm'),
    env.USERPROFILE&&p.join(env.USERPROFILE,'AppData','Roaming','npm')]
    .filter(Boolean);
  const candidates=[];
  for(const npm of new Set(npmRoots)){
    for(const [pkg,target] of names){
      candidates.push(p.join(npm,'node_modules','@openai','codex','node_modules',
        '@openai','codex-'+pkg,'vendor',target,'bin','codex.exe'));
      candidates.push(p.join(npm,'node_modules','@openai','codex','vendor',
        target,'codex','codex.exe'));
      candidates.push(p.join(npm,'node_modules','@openai','codex','vendor',
        target,'bin','codex.exe'));
    }
  }
  // Codex Desktop uses versioned directories; enumerate instead of pinning a
  // single version hash. Only select codex.exe from the known installation root.
  if(env.LOCALAPPDATA){
    const desktop=p.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    for(const sub of readDirs(desktop).slice(0,64))
      if(/^[a-zA-Z0-9._-]{1,80}$/.test(sub))
        candidates.push(p.join(desktop,sub,'codex.exe'));
  }
  for(const part of (env.Path||env.PATH||'').split(';')){
    if(part&&p.isAbsolute(part))candidates.push(p.join(part,'codex.exe'));
  }
  for(const candidate of new Set(candidates))if(isFile(candidate))return candidate;
  throw binaryError('CODEX_BINARY_NOT_FOUND',
    'Native codex.exe not found; set an absolute codexExecutable path in local Magpie settings');
}
