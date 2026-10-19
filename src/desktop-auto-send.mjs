/**
 * Native Codex Desktop one-shot, fail-closed UI Automation.
 * UIA may observe a slow launch but will never retry Invoke.
 * Return fixed reason codes without publishing window text, prompt, or paths.
 * Button invocation is NOT proof of Codex execution or ChatGPT binding.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const AUTO_SEND_RESULTS=new Set(['invoked-unconfirmed','not-verified','window-not-found',
  'composer-not-readable','composer-not-matched','send-control-not-found',
  'send-control-disabled','send-invoke-unavailable','ambiguous-target','uia-error',
  'codex-process-not-found','desktop-session-mismatch','desktop-window-unavailable',
  'desktop-window-inaccessible']);
export function desktopAutoSendScript(){
return String.raw`$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# Window titles often contain only a project/thread name; use owning HWND process.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MagpieCodexHwnd {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr hwnd);
  public static IntPtr[] VisibleWindows(){
    var handles=new List<IntPtr>();
    EnumWindows((hwnd,state)=>{ if(IsWindowVisible(hwnd)) handles.Add(hwnd); return true; },IntPtr.Zero);
    return handles.ToArray();
  }
}
'@
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAGPIE_EXPECTED_PROMPT_B64))
$root=[System.Windows.Automation.AutomationElement]::RootElement
$windowCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
$buttonCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
$deadline=[DateTime]::UtcNow.AddSeconds(12)
$reason='window-not-found'

function SamePrompt($value){
  if($null -eq $value -or $value -isnot [string]){return $false}
  $lineBreak=([string][char]13+[string][char]10)
  $clean=$value.Replace($lineBreak,[string][char]10).Replace([string][char]13,[string][char]10)
  $wanted=$expected.Replace($lineBreak,[string][char]10).Replace([string][char]13,[string][char]10)
  # Chromium TextPattern occasionally adds a single terminal newline.
  if($clean.EndsWith([string][char]10) -and -not $wanted.EndsWith([string][char]10)){
    $clean=$clean.Substring(0,$clean.Length-1)
  }
  return $clean -ceq $wanted
}

function MatchesComposer($element){
  # Electron/Chromium implementations vary: read every available text pattern.
  try{
    $pattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if(SamePrompt $pattern.Current.Value){return $true}
  }catch{}
  try{
    $pattern=$element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if(SamePrompt $pattern.DocumentRange.GetText(-1)){return $true}
  }catch{}
  try{
    $pattern=$element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if(SamePrompt $pattern.Current.Value){return $true}
  }catch{}
  try{
    if($element.Current.IsKeyboardFocusable -and (SamePrompt $element.Current.Name)){return $true}
  }catch{}
  return $false
}

function IsSendButton($button){
  $name=$button.Current.Name
  $id=$button.Current.AutomationId
  if($name -match '(?i)^(send|send message|send prompt|submit|发送|发送消息)(\s*\(.*\))?$'){return $true}
  if($id -match '(?i)^(send|send-button|send-message|submit|composer-send|composer-submit)$'){return $true}
  try{
    $p=$button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if($p.Current.Name -match '(?i)^(send|send message|send prompt|发送|发送消息)$'){return $true}
  }catch{}
  return $false
}

function InvokeButton($button){
  try{
    $p=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
    return $true
  }catch{}
  try{
    $p=$button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $p.DoDefaultAction()
    return $true
  }catch{}
  return $false
}

while([DateTime]::UtcNow -lt $deadline){
  # Do not mistake a non-interactive service session for a missing Codex UI.
  $helperSession=[System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $codexProcesses=@(Get-Process -Name 'Codex' -ErrorAction SilentlyContinue)
  $localProcesses=@($codexProcesses | Where-Object {$_.SessionId -eq $helperSession})
  # C# owns the native callback; do not depend on PowerShell delegate closures.
  $handles=[MagpieCodexHwnd]::VisibleWindows()
  $codexWindows=@()
  $codexHandleCount=0
  $seen=New-Object 'System.Collections.Generic.HashSet[long]'
  foreach($hwnd in $handles){
    [uint32]$ownerProcessId=0
    [void][MagpieCodexHwnd]::GetWindowThreadProcessId($hwnd,[ref]$ownerProcessId)
    if($ownerProcessId -eq 0){continue}
    $owner=$null
    try{$owner=[System.Diagnostics.Process]::GetProcessById([int]$ownerProcessId)}catch{continue}
    if($owner.ProcessName -ine 'Codex' -and $owner.ProcessName -ine 'OpenAI.Codex'){continue}
    if($owner.SessionId -ne $helperSession){continue}
    $codexHandleCount++
    if(-not $seen.Add($hwnd.ToInt64())){continue}
    try{
      $element=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if($null -ne $element){$codexWindows+=,$element}
    }catch{}
  }
  if($codexWindows.Count -eq 0){
    if($codexProcesses.Count -eq 0){$reason='codex-process-not-found'}
    elseif($localProcesses.Count -eq 0){$reason='desktop-session-mismatch'}
    elseif($codexHandleCount -eq 0){$reason='desktop-window-unavailable'}
    else{$reason='desktop-window-inaccessible'}
    Start-Sleep -Milliseconds 400
    continue
  }
  $reason='composer-not-readable'
  $targets=@()
  foreach($window in $codexWindows){
    try{$all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)}
    catch{$reason='desktop-window-inaccessible';continue}
    $matched=$false
    $readable=$false
    $count=[Math]::Min($all.Count,1600)
    for($i=0;$i -lt $count;$i++){
      $element=$all.Item($i)
      $kind=$element.Current.ControlType
      if($kind -ne [System.Windows.Automation.ControlType]::Edit -and
         $kind -ne [System.Windows.Automation.ControlType]::Document -and
         $kind -ne [System.Windows.Automation.ControlType]::Custom){continue}
      $readable=$true
      if(MatchesComposer $element){$matched=$true;break}
    }
    if(-not $matched){
      if($readable){$reason='composer-not-matched'}
      continue
    }
    $reason='send-control-not-found'
    $buttons=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)
    $found=0
    for($j=0;$j -lt $buttons.Count;$j++){
      $button=$buttons.Item($j)
      if(-not (IsSendButton $button)){continue}
      $found++
      if($button.Current.IsEnabled){$targets+=@{window=$window;button=$button}}
    }
    if($found -gt 0 -and $targets.Count -eq 0){$reason='send-control-disabled'}
  }
  if($targets.Count -gt 1){
    Write-Output 'ambiguous-target'
    exit 0
  }
  if($targets.Count -eq 1){
    if(InvokeButton $targets[0].button){Write-Output 'invoked-unconfirmed'}
    else{Write-Output 'send-invoke-unavailable'}
    exit 0
  }
  Start-Sleep -Milliseconds 400
}
Write-Output $reason`;
}
export async function tryVerifiedDesktopAutoSend(prompt,{platform=process.platform,run=exec}={}){
  if(platform!=='win32')return 'unsupported-platform';
  if(typeof prompt!=='string'||!prompt)return 'not-verified';
  const env={...process.env,MAGPIE_EXPECTED_PROMPT_B64:Buffer.from(prompt,'utf8').toString('base64')};
  try{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(desktopAutoSendScript(),'utf16le').toString('base64')],{
      env,windowsHide:true,timeout:16000,maxBuffer:1024
    });
    const code=stdout.trim();
    return AUTO_SEND_RESULTS.has(code)?code:'uia-error';
  }catch{return 'uia-error';}
}
){continue}
    if($owner.SessionId -ne $helperSession){continue}
    $codexHandleCount++
    if(-not $seen.Add($hwnd.ToInt64())){continue}
    try{
      $element=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if($null -ne $element){$codexWindows+=,$element}
    }catch{}
  }
  if($codexWindows.Count -eq 0){
    if($codexProcesses.Count -eq 0){$reason='codex-process-not-found'}
    elseif($localProcesses.Count -eq 0){$reason='desktop-session-mismatch'}
    elseif($codexHandleCount -eq 0){$reason='desktop-window-unavailable'}
    else{$reason='desktop-window-inaccessible'}
    Start-Sleep -Milliseconds 400
    continue
  }
  $reason='composer-not-readable'
  $targets=@()
  foreach($window in $codexWindows){
    $all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $matched=$false
    $readable=$false
    $count=[Math]::Min($all.Count,1600)
    for($i=0;$i -lt $count;$i++){
      $element=$all.Item($i)
      $kind=$element.Current.ControlType
      if($kind -ne [System.Windows.Automation.ControlType]::Edit -and
         $kind -ne [System.Windows.Automation.ControlType]::Document -and
         $kind -ne [System.Windows.Automation.ControlType]::Custom){continue}
      $readable=$true
      if(MatchesComposer $element){$matched=$true;break}
    }
    if(-not $matched){
      if($readable){$reason='composer-not-matched'}
      continue
    }
    $reason='send-control-not-found'
    $buttons=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)
    $found=0
    for($j=0;$j -lt $buttons.Count;$j++){
      $button=$buttons.Item($j)
      if(-not (IsSendButton $button)){continue}
      $found++
      if($button.Current.IsEnabled){$targets+=@{window=$window;button=$button}}
    }
    if($found -gt 0 -and $targets.Count -eq 0){$reason='send-control-disabled'}
  }
  if($targets.Count -gt 1){
    Write-Output 'ambiguous-target'
    exit 0
  }
  if($targets.Count -eq 1){
    if(InvokeButton $targets[0].button){Write-Output 'invoked-unconfirmed'}
    else{Write-Output 'send-invoke-unavailable'}
    exit 0
  }
  Start-Sleep -Milliseconds 400
}
Write-Output $reason`;
}
export async function tryVerifiedDesktopAutoSend(prompt,{platform=process.platform,run=exec}={}){
  if(platform!=='win32')return 'unsupported-platform';
  if(typeof prompt!=='string'||!prompt)return 'not-verified';
  const env={...process.env,MAGPIE_EXPECTED_PROMPT_B64:Buffer.from(prompt,'utf8').toString('base64')};
  try{
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(desktopAutoSendScript(),'utf16le').toString('base64')],{
      env,windowsHide:true,timeout:16000,maxBuffer:1024
    });
    const code=stdout.trim();
    return AUTO_SEND_RESULTS.has(code)?code:'uia-error';
  }catch{return 'uia-error';}
}
