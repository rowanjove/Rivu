import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {AIScanner} from '../dist-server/ai-scanner.js';
import {createService} from '../dist-server/service.js';
import {AIService} from '../dist-server/ai.js';
import {AIRuleService} from '../dist-server/ai-rules.js';
const worker=resolve('dist-server/ai-scan-worker.cjs'),modulePath=resolve('dist-server/ai-scan-task.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+15000;while(!check()){assert.ok(Date.now()<deadline,'scanner barrier timeout');await delay(10);}}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-ai-scanner-')),db=new RivuDatabase(join(dir,'rivu.db')),feed=db.addFeed({title:'Feed',url:'https://example.invalid/rss'});db.addEntries(feed.id,Array.from({length:205},(_,i)=>({title:'Article '+i,content:'<p>Matching body</p>',publishedAt:'2026-01-01',hash:String(i)})));return {dir,db,feed,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
test('AI scanner counts and selects in one snapshot, and keyset continues after prior-page deletions',async()=>{
  const f=fixture(),scanner=new AIScanner(worker),input={databasePath:f.db.path,conditions:{bodyKeyword:'Matching',type:'rss'},limit:100,count:true};
  try{const first=await scanner.read(input);assert.equal(first.matching,205);assert.equal(first.rows.length,100);const expected=f.db.db.prepare('SELECT id FROM entries ORDER BY COALESCE(published_at,fetched_at) DESC,id').all().map(row=>row.id);
    f.db.db.exec('BEGIN');for(const row of first.rows)f.db.db.prepare('DELETE FROM entries WHERE id=?').run(row.id);f.db.db.exec('COMMIT');
    const cursor=row=>({date:row.date,id:row.id}),second=await scanner.read({...input,cursor:cursor(first.rows.at(-1)),count:false}),third=await scanner.read({...input,cursor:cursor(second.rows.at(-1)),count:false});assert.deepEqual([first.rows.length,second.rows.length,third.rows.length],[100,100,5]);assert.deepEqual([...first.rows,...second.rows,...third.rows].map(row=>row.id),expected);
    await assert.rejects(scanner.read({...input,limit:101}),error=>error.statusCode===400);
  }finally{await scanner.stop();f.close();}
});
test('AI scanner held snapshot permits WAL writes and drains bounded queue without mixed count and candidates',async()=>{
  const f=fixture(),gate=new SharedArrayBuffer(8),flags=new Int32Array(gate),custom=join(f.dir,'held.cjs');writeFileSync(custom,`const {scanAIRule}=require(${JSON.stringify(modulePath)});exports.scanAIRule=input=>scanAIRule(input,()=>{if(input.hold){const f=new Int32Array(input.gate);Atomics.store(f,0,1);Atomics.wait(f,1,0);}});`);const scanner=new AIScanner(worker,custom,1),input={databasePath:f.db.path,conditions:{},limit:100,count:true};
  try{const first=scanner.read({...input,hold:true,gate});await until(()=>Atomics.load(flags,0)===1);const second=scanner.read(input);await assert.rejects(scanner.read(input),error=>error.resourceBusy);f.db.db.exec('DELETE FROM entries');let drained=false;const stopping=scanner.stop().then(()=>drained=true);await delay(10);assert.equal(drained,false);Atomics.store(flags,1,1);Atomics.notify(flags,1);const old=await first;assert.equal(old.matching,205);assert.equal(old.rows.length,100);const current=await second;assert.equal(current.matching,0);assert.equal(current.rows.length,0);await stopping;await assert.rejects(scanner.read(input),error=>error.statusCode===503);
  }finally{Atomics.store(flags,1,1);Atomics.notify(flags,1);await scanner.stop();f.close();}
});
test('held rule preview releases its main permit and rejects a candidate that no longer matches',async()=>{
  const f=fixture(),marker=join(f.dir,'started'),release=join(f.dir,'release'),custom=join(f.dir,'held.cjs');writeFileSync(custom,`const fs=require('node:fs'),{scanAIRule}=require(${JSON.stringify(modulePath)});exports.scanAIRule=input=>scanAIRule(input,()=>{fs.writeFileSync(${JSON.stringify(marker)},'started');while(!fs.existsSync(${JSON.stringify(release)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);});`);
  const service=createService(f.db,'token',...Array(12).fill(undefined),worker,custom),request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
  try{const {existsSync}=await import('node:fs');const preview=request('POST','/api/ai-rules/preview',{name:'Rule',conditions:{titleKeyword:'Article'},actionType:'summary',maxItems:1});await until(()=>existsSync(marker));const id=f.db.db.prepare('SELECT id FROM entries ORDER BY COALESCE(published_at,fetched_at) DESC,id LIMIT 1').get().id;assert.equal((await request('GET','/health')).statusCode,200);assert.equal((await request('PATCH',`/api/entries/${id}`,{read:true})).statusCode,200);f.db.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Excluded',id);writeFileSync(release,'release');assert.equal((await preview).statusCode,409);
  }finally{writeFileSync(release,'release');await service.stop();f.close();}
});
test('AI batch preparation failure leaves no queued rows or pump, then success commits the whole batch',async()=>{
  const f=fixture(),scanner=new AIScanner(worker);let armed=false,preparations=0,pumps=0;const ai=new AIService(f.db,undefined,undefined,async html=>{if(armed&&++preparations===2)throw Object.assign(Error('body changed'),{statusCode:409});return html;}),rules=new AIRuleService(f.db,ai,undefined,input=>scanner.read(input));rules.pump=()=>{pumps++;return Promise.resolve();};
  try{ai.configure({model:'fixture'});const rule=rules.create({name:'Batch',conditions:{},actionType:'summary',maxItems:2}),preview=await rules.preview(rule.id);await rules.enable(rule.id,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false});const ids=f.db.db.prepare('SELECT id FROM entries ORDER BY COALESCE(published_at,fetched_at) DESC,id LIMIT 2').all().map(row=>row.id);ids.forEach((id,index)=>f.db.setFullContent(id,`<p>Unique updated ${index}</p>`));armed=true;await assert.rejects(rules.enqueue(rule.id),error=>error.statusCode===409);assert.equal(f.db.db.prepare('SELECT count(*) n FROM ai_rule_jobs').get().n,0);assert.equal(pumps,0);armed=false;const result=await rules.enqueue(rule.id);assert.equal(result.queued,2);assert.equal(f.db.db.prepare('SELECT count(*) n FROM ai_rule_jobs').get().n,2);assert.equal(pumps,1);
  }finally{await scanner.stop();f.close();}
});
test('AI batch SQL failure rolls back earlier job inserts and preserves rule error state',async()=>{
  const f=fixture(),scanner=new AIScanner(worker),ai=new AIService(f.db,undefined,undefined,async html=>html),rules=new AIRuleService(f.db,ai,undefined,input=>scanner.read(input));let pumps=0;rules.pump=()=>{pumps++;return Promise.resolve();};
  try{ai.configure({model:'fixture'});const rule=rules.create({name:'Rollback',conditions:{},actionType:'summary',maxItems:2}),preview=await rules.preview(rule.id);await rules.enable(rule.id,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false});const second=f.db.db.prepare('SELECT id FROM entries ORDER BY COALESCE(published_at,fetched_at) DESC,id LIMIT 1 OFFSET 1').get().id;f.db.db.exec(`CREATE TRIGGER deny_job BEFORE INSERT ON ai_rule_jobs WHEN NEW.entry_id='${second}' BEGIN SELECT RAISE(ABORT,'denied second job'); END;`);f.db.db.prepare('UPDATE ai_rules SET last_error=? WHERE id=?').run('keep existing error',rule.id);await assert.rejects(rules.enqueue(rule.id),/denied second job/);assert.equal(f.db.db.prepare('SELECT count(*) n FROM ai_rule_jobs').get().n,0);assert.equal(f.db.db.prepare('SELECT last_error FROM ai_rules WHERE id=?').get(rule.id).last_error,'keep existing error');assert.equal(pumps,0);
  }finally{await scanner.stop();f.close();}
});
