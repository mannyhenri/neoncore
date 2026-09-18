import './helpers/isolated-db.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import db from '../src/db.js';
import router, { applyDecision } from '../src/routes/permissions.js';
import { installStubIO } from './helpers/stub-io.js';
const io = installStubIO();

test('both Codex question tools roll up, survive trust, deduplicate, and return every answer', async () => {
 const app = express(); app.use(express.json()); app.use('/permissions', router);
 const server = app.listen(0, '127.0.0.1');
 await new Promise<void>(r => server.once('listening', r));
 const address = server.address() as { port: number };
 const base = `http://127.0.0.1:${address.port}/permissions`;
 const id = 'codex-question-test';
 db.prepare(`INSERT INTO agents (id,name,machine,repo_path,repo_name,agent_type,status,last_seen,session_id,agent_mode) VALUES (?,?,'test','/tmp/questions','questions','codex','idle',?,'question-session','trust')`).run(id,id,new Date().toISOString());
 io.connect(id);
 const ids: string[] = [];
 try {
  for (const toolName of ['request_user_input', 'request_user_input_async']) {
   const payload = {sessionId:'question-session',agentType:'codex',toolName,questionCallId:toolName,toolInput:{questions:[{id:'model',question:'Model?',options:[{label:'Qwen'}]},{id:'criteria',question:'Criteria?'}]}};
   const post = async () => { const res = await fetch(`${base}/request`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); assert.ok(res.ok); return res.json() as Promise<{id:string}>; };
   const first = await post(); ids.push(first.id); assert.equal((await post()).id,first.id);
   const row = db.prepare('SELECT * FROM permissions WHERE id=?').get(first.id) as {tool_name:string;tool_input:string;status:string};
   assert.equal(row.tool_name,'AskUserQuestion'); assert.equal(row.status,'pending');
   assert.equal(JSON.parse(row.tool_input).questions.length,2);
  }
  assert.equal((db.prepare('SELECT status FROM agents WHERE id=?').get(id) as {status:string}).status,'waiting');
  const answers = {answers:{model:'Qwen2.5-Coder-32B Q4_K_M',criteria:'All acceptance criteria'}};
  for (const [i,permission] of ids.entries()) {
   assert.ok(applyDecision(permission,'allowed',answers));
   const commands = db.prepare('SELECT text FROM commands WHERE agent_id=? ORDER BY rowid').all(id) as {text:string}[];
   assert.equal(commands.length,i+1); assert.match(commands[i].text,/Qwen2.5-Coder-32B Q4_K_M/); assert.match(commands[i].text,/All acceptance criteria/);
   applyDecision(permission,'allowed',answers);
   assert.equal((db.prepare('SELECT count(*) AS n FROM commands WHERE agent_id=?').get(id) as {n:number}).n,i+1);
   const agent = db.prepare('SELECT status,pending_question FROM agents WHERE id=?').get(id) as {status:string;pending_question:string};
   assert.equal(agent.status,i===0?'waiting':'working'); assert.equal(Boolean(agent.pending_question),i===0);
  }
 } finally { await new Promise<void>(r => server.close(()=>r())); }
});
