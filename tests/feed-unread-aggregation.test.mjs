import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {RivuDatabase} from '../dist-server/database.cjs';
const {readEntrySnapshot}=createRequire(import.meta.url)('../dist-server/entry-read-task.cjs');
const clean=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-unread-aggregation-')),db=new RivuDatabase(join(directory,'rivu.db'));
 const feeds=Array.from({length:5},(_,i)=>db.addFeed({title:`Feed ${i}`,url:`https://example.invalid/${i}`,fetchInterval:0}));
 for(let i=0;i<4;i++)db.addEntries(feeds[i].id,Array.from({length:30},(_,j)=>({title:`Entry ${i}-${j}`,content:'正文😀',hash:`${i}-${j}`})));
 const entries=db.db.prepare('SELECT id,feed_id,read FROM entries ORDER BY id').all();
 const read=()=>readEntrySnapshot({databasePath:db.path,kind:'feed_metadata'});
 return {directory,db,feeds,entries,read,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
function addRule(f,id,type,enabled=1){f.db.db.prepare('INSERT INTO rules(id,name,priority,enabled,conditions,action_type,created_at,updated_at) VALUES (?,?,0,?,?,?, ?,?)').run(id,id,enabled,'{}',type,'2026','2026');}
function match(f,rule,id){f.db.db.prepare('INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,?)').run(rule,id,'2026');}
function ai(f,id,decision){f.db.setFilterDecision(id,{decision,reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'fixture'});}
function assertLegacy(f){assert.deepEqual(clean(f.read()),clean(f.db.feeds(false).map(({icon,...row})=>({...row,icon:null,iconKey:null}))));}

test('feed counts deduplicate dense overlapping rule and AI visibility, ignore read/disabled effects, and refresh after mutations',()=>{
 const f=fixture();try{
  for(const [id,type,enabled] of [['block','block',1],['mute','mute',1],['also-mute','mute',1],['disabled','block',0],['save','save',1],['tag','tag',1]])addRule(f,id,type,enabled);
  for(let i=0;i<f.entries.length;i++){
   const id=f.entries[i].id;
   if(i%4===0)f.db.updateEntry(id,{read:true});
   if(i%2===0)match(f,'block',id);
   if(i%3===0){match(f,'mute',id);match(f,'also-mute',id);}
   if(i%5===0)ai(f,id,'mute');
   if(i%7===0)ai(f,id,'block');
   match(f,'disabled',id);match(f,'save',id);match(f,'tag',id);
  }
  f.db.updateFeed(f.feeds[0].id,{enabled:false});assertLegacy(f);
  f.db.db.prepare("UPDATE rules SET enabled=0 WHERE id IN ('block','mute','also-mute')").run();assertLegacy(f);
  f.db.db.prepare('DELETE FROM ai_filter_decisions').run();assertLegacy(f);
  f.db.db.exec('UPDATE entries SET read=1');assertLegacy(f);assert.ok(f.read().every(row=>row.unread_count===0));
  f.db.db.exec('UPDATE entries SET read=0');assertLegacy(f);assert.equal(f.read().reduce((n,row)=>n+row.unread_count,0),120);
  f.db.deleteFeed(f.feeds[0].id);assertLegacy(f);
 }finally{f.close();}
});

test('base and hidden counts stay on the same WAL snapshot across visibility and reading changes',()=>{
 const f=fixture();try{
  const expected=clean(f.read()),input={databasePath:f.db.path,kind:'feed_metadata'};
  const snapshot=readEntrySnapshot(input,()=>{f.db.updateEntry(f.entries[0].id,{read:true});ai(f,f.entries[1].id,'block');f.db.updateFeed(f.feeds[0].id,{title:'After'});});
  assert.deepEqual(clean(snapshot),expected);assertLegacy(f);assert.equal(f.read().reduce((n,row)=>n+row.unread_count,0),118);
 }finally{f.close();}
});

test('metadata reads maintained counters without scanning articles, rule matches or AI decisions',()=>{
 const f=fixture(),prepare=DatabaseSync.prototype.prepare,queries=[];
 try{
  addRule(f,'save','save');for(const entry of f.entries)match(f,'save',entry.id);
  DatabaseSync.prototype.prepare=function(sql){if(sql.includes('unread_count')||sql.includes('hidden_count'))queries.push(sql);return prepare.call(this,sql);};
  f.read();DatabaseSync.prototype.prepare=prepare;assert.equal(queries.length,1);
  const plans=queries.map(sql=>f.db.db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>row.detail));
  assert.ok(plans[0].some(detail=>detail.includes('SEARCH u USING INDEX sqlite_autoindex_rivu_feed_unread_counts_1 (feed_id=?)')));
  assert.ok(!plans[0].some(detail=>/\b(entries|rule_matches|ai_filter_decisions)\b/.test(detail)));
 }finally{DatabaseSync.prototype.prepare=prepare;f.close();}
});
