/**
 * Local fixture used only by Node's mock transport tests.
 * Never run a real model or modify files.
 */
process.stdin.setEncoding('utf8');
let buffer = '';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('data', part => {
  buffer += part;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({jsonrpc:'2.0', id:m.id, result:{}});
    if (m.method === 'thread/start' || m.method === 'thread/resume') {
      send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'test-thread'}}});
    }
    if (m.method === 'turn/start') {
      send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'test-turn',status:'inProgress'}}});
      send({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:'test-thread',turnId:'test-turn',delta:'mock finished'}});
      send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed'}}});
    }
  }
});
