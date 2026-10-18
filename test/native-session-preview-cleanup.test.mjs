import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../page/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../page/app.js',import.meta.url),'utf8');
const host=readFileSync(new URL('../index.mjs',import.meta.url),'utf8');

test('obsolete Project Review preview removed while native collaboration stays',()=>{
  assert.doesNotMatch(html,/collabProjectCount|collabBoundCount|collabPreviewStatus|native-session-preview\.js/);
  assert.doesNotMatch(js,/loadNativeSessionPreview|collabBoundList/);
  assert.doesNotMatch(host,/publishNativeSessionPreview/);
  assert.match(html,/nativeDesktopAutoSendExperimental/);
  assert.match(html,/codexPermissionMode/);
});
