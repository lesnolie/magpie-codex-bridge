/**
 * Experimental Windows UI Automation submission for native Codex Desktop.
 * Fail closed: NEVER send a generic Enter key or use mouse coordinates.
 * Only invoke an enabled Send button within a UNIQUE Codex window whose
 * editable composer exposes an EXACT match for the expected prompt.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export function desktopAutoSendScript(){
return String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MAGPIE_EXPECTED_PROMPT_B64))
$root=[System.Windows.Automation.AutomationElement]::RootElement
$windowCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Window)
$editCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
$buttonCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
$candidates=@()
foreach($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children,$windowCondition)){
  $title=$window.Current.Name
  if($title -notmatch '(?i)Codex'){continue}
  foreach($edit in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$editCondition)){
    $value=$null
    try {
      $pattern=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value=$pattern.Current.Value
    } catch {continue}
    if($value -cne $expected){continue}
    foreach($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)){
      if($button.Current.Name -cne 'Send' -or -not $button.Current.IsEnabled){continue}
      $candidates+=@{window=$window;button=$button}
    }
  }
}
if($candidates.Count -ne 1){Write-Output 'not-verified';exit 0}
try{
  $invoke=$candidates[0].button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  Write-Output 'invoked-unconfirmed'
}catch{Write-Output 'not-verified'}
`;
}
export async function tryVerifiedDesktopAutoSend(prompt,{platform=process.platform,run=exec,delayMs=1200}={}){
  if(platform!=='win32')return 'unsupported-platform';
  if(typeof prompt!=='string'||!prompt)return 'not-verified';
  // UIA may not expose Electron contenteditable fields. In that case
  // deliberately leave the message in the composer for manual sending.
  await new Promise(resolve=>setTimeout(resolve,Math.min(5000,Math.max(0,delayMs))));
  const env={...process.env,MAGPIE_EXPECTED_PROMPT_B64:Buffer.from(prompt,'utf8').toString('base64')};
  try{
    const script=desktopAutoSendScript();
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(script,'utf16le').toString('base64')],{
      env,windowsHide:true,timeout:10000,maxBuffer:1024
    });
    return stdout.trim()==='invoked-unconfirmed'?'invoked-unconfirmed':'not-verified';
  }catch{return 'not-verified';}
}
