import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RivuDatabase} from '../dist-server/database.cjs';
import {validateUnreadCounts} from '../dist-server/unread-counts.js';

function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-counter-read-')),db=new RivuDatabase(join(directory,'rivu.db'));return {db,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
function check(model){
 const expected=new Map(model.db.prepare(`SELECT e.feed_id,count(*) n FROM entries e WHERE e.read=0
  AND NOT EXISTS(SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type IN ('block','mute'))
  AND NOT EXISTS(SELECT 1 FROM ai_filter_decisions a WHERE a.entry_id=e.id AND a.decision IN ('block','mute')) GROUP BY e.feed_id`).all().map(row=>[row.feed_id,row.n]));
 for(const metadata of [false,true])for(const row of model.feeds(metadata))assert.equal(row.unread_count,expected.get(row.id)||0);
 validateUnreadCounts(model.db);
}
test('both feed read modes preserve overlapping rule/AI, zero, uncommitted and rolled-back counts',()=>{
 const f=fixture();try{
  const a=f.db.addFeed({title:'B',url:'https://example.invalid/b'}),b=f.db.addFeed({title:'a',url:'https://example.invalid/a'});
  f.db.addEntries(a.id,Array.from({length:12},(_,n)=>({title:String(n),hash:'row'+n,content:'original'})));
  const ids=f.db.entries({feedId:a.id}).map(row=>row.id),insert=f.db.db.prepare("INSERT INTO rules(id,name,conditions,enabled,action_type,created_at,updated_at) VALUES (?,?,'{}',?,?, '2026','2026')");
  for(const [id,enabled,action]of [['mute',1,'mute'],['block',1,'block'],['disabled',0,'block'],['save',1,'save']]){insert.run(id,id,enabled,action);for(const entry of ids.slice(0,5))f.db.db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,'2026')").run(id,entry);}
  f.db.setFilterDecision(ids[0],{decision:'mute',reason:'test',criteria:'test',provider:'local',model:'test',content_hash:'hash'});
  f.db.updateEntry(ids[6],{read:true});check(f.db);assert.equal(f.db.feeds().find(row=>row.id===a.id).unread_count,6);assert.equal(f.db.feeds(true).find(row=>row.id===b.id).unread_count,0);
  f.db.db.exec('BEGIN');try{f.db.db.exec("UPDATE rules SET enabled=0 WHERE id IN ('block','mute'); DELETE FROM ai_filter_decisions");check(f.db);assert.equal(f.db.feeds().find(row=>row.id===a.id).unread_count,11);}finally{f.db.db.exec('ROLLBACK');}
  check(f.db);assert.equal(f.db.feeds(true).find(row=>row.id===a.id).unread_count,6);
 }finally{f.close();}
});
test('compatibility feed reads do not scan entries or visibility effects and retain icon/result shapes',()=>{
 const f=fixture();try{
  f.db.addFeed({title:'Z',url:'https://example.invalid/z',icon:'data:image/png;base64,YWJj'});f.db.addFeed({title:'a',url:'https://example.invalid/a'});
  const original=f.db.db.prepare.bind(f.db.db),queries=[];f.db.db.prepare=sql=>{queries.push(sql);return original(sql);};
  const full=f.db.feeds(),metadata=f.db.feeds(true);
  assert.deepEqual(full.map(row=>row.title),['a','Z']);assert.deepEqual(metadata.map(row=>row.title),['a','Z']);assert.equal(full[1].icon,'data:image/png;base64,YWJj');assert.equal(metadata[1].icon,null);assert.match(metadata[1].iconKey,/^[a-f0-9]{64}$/);
  assert.ok(queries.some(sql=>sql.includes('rivu_feed_unread_counts')));
  assert.equal(queries.some(sql=>/\b(?:entries|rule_matches|ai_filter_decisions|rivu_entry_visibility)\b/i.test(sql)),false,'Feed reads must use already-maintained counters');
 }finally{f.close();}
});
