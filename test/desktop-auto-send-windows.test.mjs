import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {desktopAutoSendScript,tryVerifiedDesktopAutoSend} from '../src/desktop-auto-send.mjs';
import {desktopPrompt,desktopUrl,openCodexDesktop} from '../src/native-collab.mjs';

const windows={skip:process.platform!=='win32'};
const script=desktopAutoSendScript();
function fn(name,next){
  const start=script.indexOf('function '+name);
  const end=script.indexOf('\n'+next,start);
  assert.ok(start>=0&&end>start,name+' must be embedded');
  return script.slice(start,end);
}
function runPs(body,env={}){
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'\n"+body,'utf16le').toString('base64')],
    {timeout:20000,encoding:'utf8',env:{...process.env,...env}});
  return run;
}
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const prompt=desktopPrompt({project:'magpie-free-model',goal:'  indented goal\n\nsecond paragraph',
  chatUrl:'https://chatgpt.com/c/ffffffff-1111-2222-3333-0123456789ab',
  taskId:'task-1',launchId:'launch-1'});
// Exactly how Codex Desktop 26.1013 (Chromium UIA ValuePattern) reads a prefilled
// ProseMirror composer: blank paragraphs dropped, a line's leading spaces moved
// to the end of the previous line, one trailing newline.
function chromiumReadback(text){
  const lines=text.split('\n').filter(l=>l.length>0);
  const out=[];
  for(const line of lines){
    const lead=line.match(/^ */)[0];
    if(out.length&&lead)out[out.length-1]+=lead;
    out.push(line.slice(lead.length));
  }
  return out.join('\n')+'\n';
}
const matcher=()=>`$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:EXPECTED))
${fn('CanonicalText','$wantedCanonical')}
$wantedCanonical=CanonicalText $expected
${fn('SamePrompt($value)','function MatchesComposer')}
function Check($b64){ SamePrompt ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))) }
`;

test('Chromium-flattened Codex composer text matches the dispatched prompt (composer-not-matched regression)',windows,()=>{
  assert.match(prompt,/\n\n/,'the real Magpie prompt contains blank lines');
  const observed=chromiumReadback(prompt);
  assert.notEqual(observed.trimEnd(),prompt,'the readback is not byte-identical');
  const run=runPs(matcher()+`
if(-not (Check '${b64(observed)}')){throw 'flattened readback rejected'}
if(-not (Check '${b64(prompt.replace(/\n/g,'\r\n'))}')){throw 'CRLF readback rejected'}
if(-not (Check '${b64(prompt.replace(/ /g,'\u00a0'))}')){throw 'NBSP readback rejected'}
if(-not (Check '${b64(chromiumReadback(prompt.replace('TARGET_CHAT: ','TARGET_CHAT: \n')))}')){throw 'linkified URL readback rejected'}
'ok'`,{EXPECTED:b64(prompt)});
  assert.equal(run.status,0,run.stderr);
});

test('canonical match still rejects other launches, placeholders and partial prefills',windows,()=>{
  const other=prompt.replace('LAUNCH_ID: launch-1','LAUNCH_ID: launch-2');
  const run=runPs(matcher()+`
if(Check '${b64(chromiumReadback(other))}'){throw 'different LAUNCH_ID accepted'}
if(Check '${b64('随心输入\n')}'){throw 'placeholder accepted'}
if(Check '${b64(prompt.slice(0,prompt.length-10))}'){throw 'truncated prompt accepted'}
if(Check '${b64('')}'){throw 'empty accepted'}
if(Check '${b64(prompt.replace('task-1','TASK-1'))}'){throw 'case change accepted'}
'ok'`,{EXPECTED:b64(prompt)});
  assert.equal(run.status,0,run.stderr);
});

test('send control is identified structurally and voice/dictation are never pressed',windows,()=>{
  const mock=(name,cls,id='')=>`([pscustomobject]@{Current=[pscustomobject]@{Name='${name}';ClassName='${cls}';AutomationId='${id}'}} | Add-Member -PassThru ScriptMethod GetCurrentPattern {throw 'none'})`;
  const primary='cursor-interaction size-token-button-composer flex bg-composer-primary p-0.5';
  const run=runPs(`${fn('IsSendButton','# Only the composer')}
if(-not (IsSendButton ${mock('发送',primary)})){throw 'zh send rejected'}
if(-not (IsSendButton ${mock('Send',primary)})){throw 'en send rejected'}
if(-not (IsSendButton ${mock('Envoyer',primary)})){throw 'other-locale primary rejected'}
if(IsSendButton ${mock('开始语音',primary)}){throw 'voice accepted'}
if(IsSendButton ${mock('Start voice',primary)}){throw 'en voice accepted'}
if(IsSendButton ${mock('听写','no-drag cursor-interaction')}){throw 'dictation accepted'}
if(IsSendButton ${mock('停止',primary)}){throw 'stop accepted'}
if(IsSendButton ${mock('添加文件等内容','no-drag cursor-interaction')}){throw 'attach accepted'}
'ok'`);
  assert.equal(run.status,0,run.stderr);
});

test('send button search is scoped to the matched composer, invoked once, then confirmed',()=>{
  assert.match(script,/function FindComposerSendButtons\(\$composer\)/);
  assert.match(script,/ControlType\]::Document\)\{return @\(\)\}/,'never widen past the web document');
  assert.doesNotMatch(script,/\$window\.FindAll\([^)]*\$buttonCondition/,'no window-wide button search');
  assert.equal(script.match(/InvokeButton \$buttons\[0\]/g).length,1);
  assert.match(script,/\$composers\.Count -gt 1[\s\S]*ambiguous-target/);
  assert.match(script,/\$buttons\.Count -gt 1[\s\S]*ambiguous-target/);
  assert.match(script,/sent-composer-cleared/);
  assert.doesNotMatch(script,/SendKeys|keybd_event|SendInput/);
});

test('sent-composer-cleared is surfaced without claiming execution',async()=>{
  assert.equal(await tryVerifiedDesktopAutoSend('p',{platform:'win32',
    run:async()=>({stdout:'sent-composer-cleared\n'})}),'sent-composer-cleared');
});

// Opt-in real Codex Desktop check. It submits ONE harmless prompt in a new thread:
//   set MAGPIE_LIVE_CODEX_DESKTOP_ROOT=C:\path\to\a\codex\project
test('LIVE: native Codex Desktop receives and submits a prefilled prompt once',{
  skip:process.platform!=='win32'||!process.env.MAGPIE_LIVE_CODEX_DESKTOP_ROOT
},async()=>{
  const nonce=Date.now().toString(36);
  const live=['Magpie auto-send live check '+nonce,'','  Reply with exactly: OK','Do not run tools or edit files.'].join('\n');
  await openCodexDesktop(desktopUrl(process.env.MAGPIE_LIVE_CODEX_DESKTOP_ROOT,live));
  assert.equal(await tryVerifiedDesktopAutoSend(live),'sent-composer-cleared');
});
