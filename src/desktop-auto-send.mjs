/**
 * Native Codex Desktop one-shot, fail-closed UI Automation.
 * UIA may observe a slow launch but will never retry Invoke.
 * Return fixed reason codes without publishing window text, prompt, or paths.
 * Button invocation is NOT proof of Codex execution or ChatGPT binding.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const AUTO_SEND_RESULTS=new Set(['sent-composer-cleared','invoked-unconfirmed','not-verified','window-not-found',
  'composer-not-readable','composer-not-matched','send-control-not-found',
  'send-control-disabled','send-invoke-unavailable','ambiguous-target','uia-error',
  'codex-process-not-found','desktop-session-mismatch','desktop-window-unavailable',
  'desktop-window-inaccessible','codex-package-host-unverified']);
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
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc callback, IntPtr state);
  [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool IsWindowVisible(IntPtr hwnd);
  public static IntPtr[] VisibleWindows(){
    var handles=new List<IntPtr>();
    EnumWindows((hwnd,state)=>{ if(IsWindowVisible(hwnd)) handles.Add(hwnd); return true; },IntPtr.Zero);
    return handles.ToArray();
  }
  public static bool HasApprovedChild(IntPtr frame, uint[] approvedPids){
    var approved=new HashSet<uint>(approvedPids);
    bool found=false;
    EnumChildWindows(frame,(child,state)=>{
      uint pid=0;
      GetWindowThreadProcessId(child,out pid);
      if(approved.Contains(pid)){found=true;return false;}
      return true;
    },IntPtr.Zero);
    return found;
  }
}
'@
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAGPIE_EXPECTED_PROMPT_B64))
$buttonCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
$deadline=[DateTime]::UtcNow.AddSeconds(12)
$reason='window-not-found'
# Codex MSIX sometimes hosts its GUI in app\ChatGPT.exe.
$approvedPackageRoots=@()
try{
  foreach($pkg in @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)){
    if([string]::IsNullOrWhiteSpace($pkg.InstallLocation)){continue}
    $approvedPackageRoots+=($pkg.InstallLocation.TrimEnd([char]92)+[string][char]92)
  }
}catch{}
function IsApprovedCodexAppHost($process){
  if($process.ProcessName -ine 'ChatGPT'){return $false}
  $exe=$null
  try{$exe=$process.MainModule.FileName}catch{return $false}
  if([string]::IsNullOrWhiteSpace($exe)){return $false}
  $suffix=([string][char]92)+'app'+([string][char]92)+'ChatGPT.exe'
  foreach($root in $approvedPackageRoots){
    if($exe.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -and
       $exe.EndsWith($suffix,[StringComparison]::OrdinalIgnoreCase)){return $true}
  }
  # Registration can be unavailable; still require WindowsApps
  # OpenAI.Codex package family and its exact GUI executable.
  return ($exe -match '(?i)[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$')
}

# Chromium flattens ProseMirror paragraphs for UIA: empty paragraphs vanish and
# leading spaces of a line surface as trailing spaces of the previous line.
# Compare a canonical form; TASK_ID/LAUNCH_ID keep it unique per launch.
function CanonicalText($value){
  if($null -eq $value -or $value -isnot [string]){return $null}
  $text=$value.Replace([string][char]13+[string][char]10,[string][char]10).Replace([string][char]13,[string][char]10)
  $lines=@()
  foreach($line in $text.Split([char]10)){
    $line=([regex]::Replace($line,'[\s\u00A0\u200B\uFEFF]+',' ')).Trim()
    if($line.Length -gt 0){$lines+=$line}
  }
  return ($lines -join [string][char]10)
}
$wantedCanonical=CanonicalText $expected

function SamePrompt($value){
  $clean=CanonicalText $value
  if([string]::IsNullOrEmpty($clean)){return $false}
  return $clean -ceq $wantedCanonical
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
  $class=[string]$button.Current.ClassName
  if($name -match '(?i)(voice|dictat|stop|cancel|interrupt|语音|听写|停止|取消|中断)'){return $false}
  # Codex composer's primary action carries this design token in every locale.
  if($class -match '(^|\s)bg-composer-primary(\s|$)'){return $true}
  if($name -match '(?i)^(send|send message|send prompt|submit|发送|发送消息)(\s*\(.*\))?$'){return $true}
  if($id -match '(?i)^(send|send-button|send-message|submit|composer-send|composer-submit)$'){return $true}
  try{
    $p=$button.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if($p.Current.Name -match '(?i)^(send|send message|send prompt|发送|发送消息)$'){return $true}
  }catch{}
  return $false
}

# Only the composer's own container: the window also hosts ChatGPT web views
# with their own composers and send buttons.
function FindComposerSendButtons($composer){
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node=$composer
  for($depth=0;$depth -lt 6;$depth++){
    try{$node=$walker.GetParent($node)}catch{return @()}
    if($null -eq $node){return @()}
    if($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document){return @()}
    $buttons=$node.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)
    $sendButtons=@()
    for($j=0;$j -lt $buttons.Count;$j++){
      $button=$buttons.Item($j)
      if(IsSendButton $button){$sendButtons+=,$button}
    }
    if($sendButtons.Count -gt 0){return ,$sendButtons}
  }
  return @()
}

function ComposerCleared($composer){
  try{
    $value=$composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
    return -not (SamePrompt $value)
  }catch{
    # The composer is replaced by the thread view once the turn starts.
    return $true
  }
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
  $candidates=@(Get-Process -Name 'Codex','OpenAI.Codex','ChatGPT' -ErrorAction SilentlyContinue)
  $codexProcesses=@()
  $unverifiedPackageHost=$false
  foreach($process in $candidates){
    if($process.ProcessName -ieq 'Codex' -or $process.ProcessName -ieq 'OpenAI.Codex'){
      $codexProcesses+=,$process
    }elseif(IsApprovedCodexAppHost $process){
      $codexProcesses+=,$process
    }elseif($process.ProcessName -ieq 'ChatGPT' -and $process.SessionId -eq $helperSession){
      $unverifiedPackageHost=$true
    }
  }
  $localProcesses=@($codexProcesses | Where-Object {$_.SessionId -eq $helperSession})
  [uint32[]]$trustedPids=@($localProcesses | ForEach-Object {[uint32]$_.Id})
  # C# owns the native callback; do not depend on PowerShell delegate closures.
  $handles=[MagpieCodexHwnd]::VisibleWindows()
  $codexWindows=@()
  $codexHandleCount=0
  $seen=[System.Collections.Generic.HashSet[long]]::new()
  foreach($hwnd in $handles){
    [uint32]$ownerProcessId=0
    [void][MagpieCodexHwnd]::GetWindowThreadProcessId($hwnd,[ref]$ownerProcessId)
    if($ownerProcessId -eq 0){continue}
    $owner=$null
    try{$owner=[System.Diagnostics.Process]::GetProcessById([int]$ownerProcessId)}catch{continue}
    if($owner.SessionId -ne $helperSession){continue}
    $direct=$trustedPids -contains ([uint32]$ownerProcessId)
    $framed=$false
    if(-not $direct -and $owner.ProcessName -ieq 'ApplicationFrameHost' -and $trustedPids.Length -gt 0){
      $framed=[MagpieCodexHwnd]::HasApprovedChild($hwnd,$trustedPids)
    }
    if(-not $direct -and -not $framed){continue}
    $codexHandleCount++
    if(-not $seen.Add($hwnd.ToInt64())){continue}
    try{
      $element=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if($null -ne $element){$codexWindows+=,$element}
    }catch{}
  }
  if($codexWindows.Count -eq 0){
    if($codexProcesses.Count -eq 0 -and $unverifiedPackageHost){$reason='codex-package-host-unverified'}
    elseif($codexProcesses.Count -eq 0){$reason='codex-process-not-found'}
    elseif($localProcesses.Count -eq 0){$reason='desktop-session-mismatch'}
    elseif($codexHandleCount -eq 0 -and $unverifiedPackageHost){$reason='codex-package-host-unverified'}
    elseif($codexHandleCount -eq 0){$reason='desktop-window-unavailable'}
    else{$reason='desktop-window-inaccessible'}
    Start-Sleep -Milliseconds 400
    continue
  }
  $reason='composer-not-readable'
  $composers=@()
  foreach($window in $codexWindows){
    try{$all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)}
    catch{$reason='desktop-window-inaccessible';continue}
    $readable=$false
    $count=[Math]::Min($all.Count,4000)
    for($i=0;$i -lt $count;$i++){
      $element=$all.Item($i)
      $kind=$element.Current.ControlType
      if($kind -ne [System.Windows.Automation.ControlType]::Edit -and
         $kind -ne [System.Windows.Automation.ControlType]::Document -and
         $kind -ne [System.Windows.Automation.ControlType]::Custom){continue}
      $readable=$true
      if(MatchesComposer $element){$composers+=,$element}
    }
    if($readable -and $composers.Count -eq 0){$reason='composer-not-matched'}
  }
  if($composers.Count -gt 1){
    Write-Output 'ambiguous-target'
    exit 0
  }
  if($composers.Count -eq 1){
    $composer=$composers[0]
    $buttons=@(FindComposerSendButtons $composer)
    if($buttons.Count -gt 1){
      Write-Output 'ambiguous-target'
      exit 0
    }
    if($buttons.Count -eq 0){
      $reason='send-control-not-found'
    }elseif(-not $buttons[0].Current.IsEnabled){
      $reason='send-control-disabled'
    }else{
      # One-shot: never invoke again, whatever the confirmation shows.
      if(-not (InvokeButton $buttons[0])){
        Write-Output 'send-invoke-unavailable'
        exit 0
      }
      $confirmDeadline=[DateTime]::UtcNow.AddSeconds(5)
      while([DateTime]::UtcNow -lt $confirmDeadline){
        if(ComposerCleared $composer){
          Write-Output 'sent-composer-cleared'
          exit 0
        }
        Start-Sleep -Milliseconds 250
      }
      Write-Output 'invoked-unconfirmed'
      exit 0
    }
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
      env,windowsHide:true,timeout:24000,maxBuffer:1024
    });
    const code=stdout.trim();
    return AUTO_SEND_RESULTS.has(code)?code:'uia-error';
  }catch{return 'uia-error';}
}
