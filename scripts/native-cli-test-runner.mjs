#!/usr/bin/env node
// Explicit local-only one-shot worker. No HTTP server, MCP tool or generic command.
import {runLocalCliTestWorker} from '../src/local-cli-test.mjs';
const [dir,id]=process.argv.slice(2);
if(!dir||!id){process.exitCode=2;}
else runLocalCliTestWorker(dir,id).catch(()=>{
  // No raw exception messages: project paths and credentials may appear.
  process.exitCode=1;
});
