/**
 * Native Codex Desktop one-shot, fail-closed UI Automation.
 * UIA may observe a slow launch but will never retry Invoke.
 * Button invocation is NOT proof of Codex execution or ChatGPT binding.
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
$buttonCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
$controls=@([System.Windows.Automation.ControlType]::Edit,[System.Windows.Automation.ControlType]::Document)
$deadline=[DateTime]::UtcNow.AddSeconds(12)
function ReadComposer($edit){
  try{
    $vp=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return $vp.Current.Value
  }catch{}
  try{
    $tp=$edit.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    return $tp.DocumentRange.GetText(-1)
  }catch{}
  return $null
}
while([DateTime]::UtcNow -lt $deadline){
  $candidates=@()
  foreach($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children,$windowCondition)){
    if($window.Current.Name -notmatch '(?i)Codex'){continue}
    $verified=$false
    foreach($control in $controls){
      $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$control)
      foreach($edit in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)){
        $value=ReadComposer $edit
        if($null -ne $value -and (($value -replace '\r\n',[string][char]10) -ceq ($expected -replace '\r\n',[string][char]10))){$verified=$true}
      }
    }
    if(-not $verified){continue}
    foreach($button in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)){
      if($button.Current.Name -notin @('Send','Send message','发送','发送消息')){continue}
      if(-not $button.Current.IsEnabled){continue}
      $candidates+=@{window=$window;button=$button}
    }
  }
  if($candidates.Count -gt 1){Write-Output 'not-verified';exit 0}
  if($candidates.Count -eq 1){
    try{
      $invoke=$candidates[0].button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $invoke.Invoke()
      Write-Output 'invoked-unconfirmed'
    }catch{Write-Output 'not-verified'}
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Write-Output 'not-verified'
`;
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
    return stdout.trim()==='invoked-unconfirmed'?'invoked-unconfirmed':'not-verified';
  }catch{return 'not-verified';}
}
