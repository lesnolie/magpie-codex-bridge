import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopAutoSendScript,tryVerifiedDesktopAutoSend} from '../src/desktop-auto-send.mjs';

test('sender is never invoked on unsupported platforms', async()=>{
  let calls=0;
  assert.equal(await tryVerifiedDesktopAutoSend('hello',{platform:'linux',run:async()=>{calls++;}}),'unsupported-platform');
  assert.equal(calls,0);
});
test('PowerShell implementation requires exact prompt, a unique window and InvokePattern',()=>{
  const s=desktopAutoSendScript();
  assert.match(s,/\-cne \$expected/);
  assert.match(s,/\$matches\.Count \-ne 1/);
  assert.match(s,/InvokePattern/);
  assert.doesNotMatch(s,/SendKeys|keybd_event|SendInput/);
});
test('recognized invocation is still unconfirmed execution',async()=>{
  const result=await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',delayMs:0,
    run:async(_binary,args,options)=>{
      assert.equal(args[0],'-NoProfile');
      assert.ok(options.env.MAGPIE_EXPECTED_PROMPT_B64);
      return {stdout:'invoked-unconfirmed\n'};
    }});
  assert.equal(result,'invoked-unconfirmed');
});
test('fail-closed when automation cannot verify the target',async()=>{
  assert.equal(await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',delayMs:0,
    run:async()=>({stdout:'not-verified\n'})}),'not-verified');
  assert.equal(await tryVerifiedDesktopAutoSend('prompt',{platform:'win32',delayMs:0,
    run:async()=>{throw Error('UI inaccessible')}}),'not-verified');
});
