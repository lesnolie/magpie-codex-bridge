import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {desktopAutoSendScript,tryVerifiedDesktopAutoSend,AUTO_SEND_RESULTS} from '../src/desktop-auto-send.mjs';

test('sender is never invoked on unsupported platforms',async()=>{
  let calls=0;
  assert.equal(await tryVerifiedDesktopAutoSend('hello',{platform:'linux',run:async()=>{calls++;}}),'unsupported-platform');
  assert.equal(calls,0);
});
test('sender cannot submit without a uniquely verified exact native composer and action',()=>{
  const s=desktopAutoSendScript();
  assert.match(s,/\$clean -ceq \$wanted/);
  assert.match(s,/\$targets\.Count -gt 1/);
  assert.match(s,/InvokePattern/);
  assert.match(s,/LegacyIAccessiblePattern/);
  assert.match(s,/TextPattern/);
  assert.match(s,/ValuePattern/);
  assert.match(s,/ControlType\]::Custom/);
  assert.match(s,/AddSeconds\(12\)/);
  assert.match(s,/\[MagpieCodexHwnd\]::VisibleWindows\(\)/);
  assert.match(s,/GetWindowThreadProcessId/);
  assert.match(s,/\$owner\.ProcessName -ine 'Codex'/);
  assert.match(s,/desktop-session-mismatch/);
  assert.match(s,/desktop-window-unavailable/);
  assert.doesNotMatch(s,/\$window\.Current\.Name -match/);

  assert.doesNotMatch(s,/SendKeys|keybd_event|SendInput/);
  assert.doesNotMatch(s,/Write-Output \$expected/);
});
test('PowerShell source parses on a Windows CI runner', {skip:process.platform!=='win32'},()=>{
  const encoded=Buffer.from(desktopAutoSendScript(),'utf16le').toString('base64');
  const parse=`[ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))) | Out-Null`;
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',parse],{timeout:12000,encoding:'utf8'});
  assert.equal(run.status,0,'PowerShell UIA script syntax must parse');
});
test('recognized action invocation is never mistaken for Codex execution',async()=>{
  const result=await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',
    run:async(_binary,args,options)=>{
      assert.equal(args[0],'-NoProfile');
      assert.ok(options.env.MAGPIE_EXPECTED_PROMPT_B64);
      return {stdout:'invoked-unconfirmed\n'};
    }});
  assert.equal(result,'invoked-unconfirmed');
});
test('specific safe diagnostics survive instead of collapsing into not-verified',async()=>{
  for(const status of ['window-not-found','composer-not-readable','composer-not-matched',
     'send-control-not-found','send-control-disabled','send-invoke-unavailable','ambiguous-target']){
    assert.ok(AUTO_SEND_RESULTS.has(status));
    assert.equal(await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',
      run:async()=>({stdout:status+'\n'})}),status);
  }
});
test('unexpected helper output and execution failures are redacted',async()=>{
  assert.equal(await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',
    run:async()=>({stdout:'private-user-prompt\n'})}),'uia-error');
  assert.equal(await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',
    run:async()=>{throw Error('private chat URL')}}),'uia-error');
});

test('native Windows HWND API compiles and enumerates without depending on window titles',{
  skip:process.platform!=='win32'
},()=>{
  const script=desktopAutoSendScript();
  const match=script.match(/Add-Type -TypeDefinition @'\\n([\\s\\S]+?)\\n'@/);
  assert.ok(match,'native HWND declaration must be embedded');
  const ps="$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n"+match[1]+"\n'@\n"+
    "$windows=[MagpieCodexHwnd]::VisibleWindows();"+
    "if($null -eq $windows){throw 'EnumWindows returned null'};";
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(ps,'utf16le').toString('base64')],{timeout:15000,encoding:'utf8'});
  assert.equal(run.status,0,'Win32 HWND interop must compile and execute');
});
test('new process/session discovery diagnostics remain fixed allowlisted labels',async()=>{
  for(const code of ['codex-process-not-found','desktop-session-mismatch',
     'desktop-window-unavailable','desktop-window-inaccessible']){
    assert.ok(AUTO_SEND_RESULTS.has(code));
    const r=await tryVerifiedDesktopAutoSend('probe',{platform:'win32',
      run:async()=>({stdout:code+'\n'})});
    assert.equal(r,code);
  }
});
