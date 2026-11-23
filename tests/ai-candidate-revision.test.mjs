import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {AIScanner} from '../dist-server/ai-scanner.js';
import {AIService} from '../dist-server/ai.js';
import {AIRuleService} from '../dist-server/ai-rules.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-candidate-revision-')),db=new RivuDatabase(join(dir,'rivu.db')),feed=db.addFeed({title:'Local',url:'https://example.invalid/feed',fetchInterval:0});db.addEntries(feed.id,[{title:'First',content:'<p>Needle body</p>',publishedAt:'2026-01-01',hash:'one'},{title:'Second',content:'<p>Other body</p>',publishedAt:'2026-01-01',hash:'two'}]);const scanner=new AIScanner(resolve('dist-server/ai-scan-worker.cjs'));return {dir,db,feed,scanner,id:db.entries().find(row=>row.title==='First').id,async close(){await scanner.stop();db.close();rmSync(dir,{recursive:true,force:true});}};}
function metadataOnly(f){const prepare=f.db.db.prepare.bind(f.db.db);let checks=0;f.db.db.prepare=sql=>{assert.ok(!sql.includes('instr(lower(COALESCE('),'main connection must not rerun body keyword SQL');if(sql.includes('e.body_revision=?'))checks++;return prepare(sql);};return ()=>checks;}
async function enable(rules,conditions,maxItems=1){const row=rules.create({name:'Rule',conditions,actionType:'summary',maxItems}),preview=await rules.preview(row.id);await rules.enable(row.id,{scopeHash:preview.scopeHash,confirmSend:true,autoRun:false});return row;}
test('Worker single-entry scan binds body predicate, ID and revision to the same snapshot',async()=>{
  const f=fixture();try{const input={databasePath:f.db.path,conditions:{bodyKeyword:'Needle'},limit:1,count:true,entryId:f.id},result=await f.scanner.read(input);assert.equal(result.matching,1);assert.equal(result.rows[0].body_revision,f.db.aiBodyIdentity(f.id).body_revision);assert.equal(result.rows[0].id,f.id);const other=f.db.entries().find(row=>row.title==='Second').id;assert.deepEqual(await f.scanner.read({...input,entryId:other}),{matching:0,rows:[]});assert.deepEqual(await f.scanner.read({...input,entryId:'missing'}),{matching:0,rows:[]});
  }finally{await f.close();}
});
test('preview, atomic enqueue and processing use Worker body predicates with metadata-only main checks',async()=>{
  const f=fixture(),ai=new AIService(f.db,undefined,undefined,async html=>html),rules=new AIRuleService(f.db,ai,undefined,input=>f.scanner.read(input));let calls=0;ai.configure({model:'fixture'});ai.action=async()=>{calls++;return {content:'Local fixture',cached:false};};rules.pump=()=>Promise.resolve();
  try{const checks=metadataOnly(f),rule=await enable(rules,{bodyKeyword:'Needle'});assert.equal((await rules.enqueue(rule.id)).queued,1);await AIRuleService.prototype.pump.call(rules);assert.equal(calls,1);assert.equal(f.db.db.prepare('SELECT status FROM ai_rule_jobs WHERE rule_id=?').get(rule.id).status,'done');assert.ok(checks()>=6);
  }finally{await rules.wait();await f.close();}
});
test('snapshot candidate changes are rejected even if the new HTML still contains the same keyword',async()=>{
  const f=fixture(),ai=new AIService(f.db,undefined,undefined,async html=>html),rules=new AIRuleService(f.db,ai,undefined,async input=>{const result=await f.scanner.read(input);f.db.setFullContent(f.id,'<p>Needle changed but still matching</p>');return result;});
  try{metadataOnly(f);await assert.rejects(rules.previewDraft({name:'Rule',conditions:{bodyKeyword:'Needle'},actionType:'summary',maxItems:1}),error=>error.statusCode===409);
  }finally{await f.close();}
});
test('metadata conditions and feed identity are rechecked after the Worker snapshot',async t=>{
  for(const variant of ['manual-tag','rule-tag','feed-type','date','feed-title'])await t.test(variant,async()=>{
    const f=fixture(),tag=f.db.addTag('Tag'),conditions={bodyKeyword:'Needle'};let mutate;
    if(variant==='manual-tag'){conditions.tagId=tag.id;f.db.setEntryTags(f.id,[tag.id]);mutate=()=>f.db.setEntryTags(f.id,[]);}
    if(variant==='rule-tag'){conditions.tagId=tag.id;f.db.db.prepare('INSERT INTO rules(id,name,enabled,conditions,action_type,tag_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('tag-rule','Tag rule',1,'{}','tag',tag.id,'2026-01-01','2026-01-01');f.db.db.prepare('INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,?)').run('tag-rule',f.id,'2026-01-01');mutate=()=>f.db.db.prepare('UPDATE rules SET enabled=0 WHERE id=?').run('tag-rule');}
    if(variant==='feed-type'){conditions.type='rss';mutate=()=>f.db.db.prepare('UPDATE feeds SET type=? WHERE id=?').run('newsletter',f.feed.id);}
    if(variant==='date'){conditions.before='2026-01-02';mutate=()=>f.db.db.prepare('UPDATE entries SET published_at=? WHERE id=?').run('2030-01-01',f.id);}
    if(variant==='feed-title')mutate=()=>f.db.db.prepare('UPDATE feeds SET title=? WHERE id=?').run('Renamed',f.feed.id);
    const revision=f.db.aiBodyIdentity(f.id).body_revision,ai=new AIService(f.db,undefined,undefined,async html=>html),rules=new AIRuleService(f.db,ai,undefined,async input=>{const result=await f.scanner.read(input);mutate();assert.equal(f.db.aiBodyIdentity(f.id).body_revision,revision);return result;});
    try{metadataOnly(f);await assert.rejects(rules.previewDraft({name:'Rule',conditions,actionType:'summary',maxItems:1}),error=>error.statusCode===409);}finally{await f.close();}
  });
});
test('processing rejects a candidate changed after its single-entry scan before calling a model',async()=>{
  const f=fixture(),ai=new AIService(f.db,undefined,undefined,async html=>html);let calls=0,armed=false;ai.configure({model:'fixture'});ai.action=async()=>{calls++;return {content:'Unexpected',cached:false};};const rules=new AIRuleService(f.db,ai,undefined,async input=>{const result=await f.scanner.read(input);if(armed&&input.entryId)f.db.setFullContent(f.id,'<p>Needle new revision</p>');return result;});rules.pump=()=>Promise.resolve();
  try{metadataOnly(f);const rule=await enable(rules,{bodyKeyword:'Needle'});await rules.enqueue(rule.id);armed=true;await AIRuleService.prototype.pump.call(rules);assert.equal(calls,0);assert.equal(f.db.db.prepare('SELECT status FROM ai_rule_jobs WHERE rule_id=?').get(rule.id).status,'failed');
  }finally{await rules.wait();await f.close();}
});
test('late revision change invalidates the whole staged batch even when the sent-text hash is unchanged',async()=>{
  const f=fixture(),html='<p>Needle '+('x'.repeat(45000))+'</p>';f.db.setFullContent(f.id,html);const other=f.db.entries().find(row=>row.title==='Second').id;f.db.setFullContent(other,html+'Other');const ai=new AIService(f.db,undefined,undefined,async value=>value),rules=new AIRuleService(f.db,ai,undefined,input=>f.scanner.read(input));let armed=false,pumps=0,baselineHash;ai.configure({model:'fixture'});rules.pump=()=>{pumps++;return Promise.resolve();};const prepare=ai.withPreparedBodies.bind(ai);ai.withPreparedBodies=(ids,action,replay)=>{const changed=armed&&ids.length===2;if(changed)f.db.setFullContent(f.id,html+'Later suffix');return prepare(ids,()=>{if(changed)assert.equal(ai.previewAction(f.id,'summary').hash,baselineHash);return action();},replay);};
  try{metadataOnly(f);const rule=await enable(rules,{bodyKeyword:'Needle'},2);baselineHash=await prepare([f.id],()=>ai.previewAction(f.id,'summary').hash);armed=true;await assert.rejects(rules.enqueue(rule.id),error=>error.statusCode===409);assert.equal(f.db.db.prepare('SELECT count(*) n FROM ai_rule_jobs').get().n,0);assert.equal(pumps,0);
  }finally{await f.close();}
});
test('processing refuses a scan proof carrying another entry ID',async()=>{
  const f=fixture(),ai=new AIService(f.db,undefined,undefined,async html=>html);let armed=false,calls=0;ai.configure({model:'fixture'});ai.action=async()=>{calls++;return {content:'Unexpected',cached:false};};const rules=new AIRuleService(f.db,ai,undefined,async input=>{const result=await f.scanner.read(input);if(armed&&input.entryId)result.rows[0]={...result.rows[0],id:'another-entry'};return result;});rules.pump=()=>Promise.resolve();
  try{metadataOnly(f);const rule=await enable(rules,{bodyKeyword:'Needle'});await rules.enqueue(rule.id);armed=true;await AIRuleService.prototype.pump.call(rules);assert.equal(calls,0);assert.equal(f.db.db.prepare('SELECT status FROM ai_rule_jobs WHERE rule_id=?').get(rule.id).status,'failed');
  }finally{await rules.wait();await f.close();}
});
