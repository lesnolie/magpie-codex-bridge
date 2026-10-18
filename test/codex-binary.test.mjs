import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveCodexBinary} from '../src/codex-tasks.mjs';

const win=path.win32;
const env={APPDATA:'C:/Users/test/AppData/Roaming',
  LOCALAPPDATA:'C:/Users/test/AppData/Local',PATH:''};
const prefix=win.join(env.APPDATA,'npm');
function runFor(files,extra={},runtime={}){
  const available=new Set(files);
  return resolveCodexBinary(extra,{platform:'win32',arch:'x64',env,
    isFile:p=>available.has(p),readDirs:()=>[],...runtime});
}
test('modern npm win32-x64 native exe is detected, not command shims',()=>{
  const native=win.join(prefix,'node_modules','@openai','codex','node_modules',
    '@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  assert.equal(runFor([native]),native);
  assert.equal(runFor([native,win.join(prefix,'codex.cmd')]),native);
});
test('manual native executable is honored before auto discovery',()=>{
  const manual='D:/Tools/Codex/codex.exe';
  assert.equal(runFor([manual],{codexExecutable:manual}),manual);
  assert.throws(()=>runFor([],{codexExecutable:'C:/Tools/codex.cmd'}),
    e=>e.code==='CODEX_BINARY_INVALID');
  assert.throws(()=>runFor([],{codexExecutable:manual}),
    e=>e.code==='CODEX_BINARY_NOT_FOUND'&&!e.message.includes('D:/Tools'));
});
test('Windows ARM64 first uses ARM64 native npm package and can fall back to x64',()=>{
  const arm=win.join(prefix,'node_modules','@openai','codex','node_modules',
    '@openai','codex-win32-arm64','vendor','aarch64-pc-windows-msvc','bin','codex.exe');
  const x64=win.join(prefix,'node_modules','@openai','codex','node_modules',
    '@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  assert.equal(runFor([arm,x64],{}, {arch:'arm64'}),arm);
  assert.equal(runFor([x64],{}, {arch:'arm64'}),x64);
});
test('PATH native exe or versioned Desktop native exe is a fallback',()=>{
  const withPath={...env,Path:'D:/Bin;D:/Shims'};
  const exe=win.join('D:/Bin','codex.exe');
  assert.equal(runFor([exe],{}, {env:withPath}),exe);
  const desktop=win.join(env.LOCALAPPDATA,'OpenAI','Codex','bin','e78bad','codex.exe');
  assert.equal(runFor([desktop],{}, {readDirs:()=>['e78bad']}),desktop);
});
test('missing Windows native exe reports deterministic classification, not shell shim',()=>{
  assert.throws(()=>runFor([]),e=>e.code==='CODEX_BINARY_NOT_FOUND'&&
    /codexExecutable/.test(e.message));
  assert.equal(resolveCodexBinary({}, {platform:'linux'}),'codex');
});
