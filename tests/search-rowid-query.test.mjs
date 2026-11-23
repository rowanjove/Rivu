import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {queryEntries as legacy} from './fixtures/schema36-entry-query.mjs';
const plain=value=>JSON.parse(JSON.stringify(value));
test('muted candidate pages preserve raw rule/AI membership for read, blocked and unread combinations',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-muted-search-')),model=new RivuDatabase(join(directory,'rivu.db'));
 try{
  const feed=model.addFeed({title:'Mute fixture',url:'https://example.invalid/muted'});
  model.addEntries(feed.id,Array.from({length:6000},(_,i)=>({title:i<1100?'mutedbridge companionbridge':'noise',content:'正文 '+i,hash:String(i),publishedAt:'2026-01-01T00:00:00Z'})));
  const ids=model.db.prepare("SELECT id FROM entries WHERE title='mutedbridge companionbridge' ORDER BY rowid").all().map(row=>row.id);
  model.db.exec("BEGIN;INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) SELECT lower(hex(randomblob(16))),id,'summary','','local','test',CASE WHEN title='mutedbridge companionbridge' THEN 'mutedbridge companionbridge' ELSE 'irrelevant unrelated' END,'v1','test','2026' FROM entries;UPDATE entries SET title='AI only source' WHERE title='mutedbridge companionbridge';COMMIT");
  model.db.exec("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES ('mute-rule','Mute','{}','mute','2026','2026'),('block-rule','Block','{}','block','2026','2026')");
  const insert=model.db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,'2026')");
  for(const [i,id] of ids.entries()){
   if(i%2===0)model.setFilterDecision(id,{decision:'mute',reason:'test',criteria:'test',provider:'local',model:'test',content_hash:'test'});
   if(i%3===0)insert.run('mute-rule',id);if(i%5===0)insert.run('block-rule',id);if(i%4===0)model.updateEntry(id,{read:true});
  }
  let fast=0,shortened=0;const prepare=model.db.prepare.bind(model.db);model.db.prepare=sql=>{if(sql.includes('FROM rivu_search_entries s')&&sql.includes("rr.action_type='mute'"))fast++;const statement=prepare(sql);if(sql.startsWith('SELECT group_concat(entry_rowid')){const get=statement.get;statement.get=function(...args){if(args[0]==='"mutedbridge"'&&args[1]==='"mut"')shortened++;return get.apply(this,args);};}return statement;};
  const compare=options=>{for(const listOnly of [true,false])assert.deepEqual(plain(model.entries({...options,listOnly})),plain(legacy(model.db,{...options,listOnly})));};
  for(const options of [{query:'mutedbridge companionbridge is:muted'},{query:'mutedbridge is:muted is:unread'},{query:'mutedbridge is:muted',view:'blocked'},{query:'mutedbridge is:muted',view:'unread'}]){
   for(const offset of [0,130,300,600,1100])compare({...options,offset,limit:20});
   const anchor=legacy(model.db,{...options,offset:5,limit:1})[0];if(anchor)compare({...options,limit:20,cursor:{sortTime:anchor.published_at||anchor.fetched_at,id:anchor.id}});
  }
  assert.ok(fast>0,'muted predicate must execute inside candidate selection');
  assert.ok(shortened>0,'AI-only matches must exercise shortened candidate binding, including the rowid path');
  model.db.exec("UPDATE rules SET enabled=0 WHERE id='mute-rule'");compare({query:'mutedbridge companionbridge is:muted',limit:100});
  model.db.exec('BEGIN');model.db.exec("UPDATE rules SET enabled=0 WHERE id='block-rule'");compare({query:'mutedbridge is:muted',view:'blocked',limit:100});model.db.exec('ROLLBACK');compare({query:'mutedbridge is:muted',view:'blocked',limit:100});
 }finally{model.close();rmSync(directory,{recursive:true,force:true});}
});
test('rowid text adapter preserves all frozen fields for article/summary OR, filters, mixed terms, cursors and orphan slots',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-search-adapter-')),model=new RivuDatabase(join(directory,'rivu.db'));
 try{
  const category=model.addCategory('selected'),a=model.addFeed({title:'Source A',url:'https://example.invalid/a',categoryId:category.id}),b=model.addFeed({title:'Source B',url:'https://example.invalid/b'});
  for(const feed of [a,b])model.addEntries(feed.id,Array.from({length:900},(_,i)=>({title:i%3?'partial token':'other',content:'正文 '+i,hash:feed.id+i,publishedAt:`2026-01-${String(i%20+1).padStart(2,'0')}T00:00:00Z`})));
  const ids=model.entries({limit:200}).map(row=>row.id);
  for(let i=0;i<ids.length;i++){if(i%4===0)model.saveAI(ids[i],'summary','','local','test','partial 摘要 only','hash','v1');if(i%7===0)model.setFilterDecision(ids[i],{decision:'block',reason:'test',criteria:'test',provider:'local',model:'test',content_hash:'test'});if(i%11===0)model.updateEntry(ids[i],{read:true});}
  let fast=0,binary=0,binaryTail=0;const prepare=model.db.prepare.bind(model.db);model.db.prepare=sql=>{if(sql.includes('FROM rivu_search_entries s INDEXED BY'))fast++;if(sql.includes('substr(?,s.entry_rowid-?+1,1)')){binary++;if(sql.includes('ORDER BY s.sort_time ASC'))binaryTail++;}return prepare(sql);};
  const compare=options=>{for(const listOnly of [true,false]){const actual=model.entries({...options,listOnly}),expected=legacy(model.db,{...options,listOnly});assert.deepEqual(plain(actual),plain(expected),JSON.stringify({...options,listOnly}));assert.ok(actual.every(row=>!('storage_id' in row)));}};
  for(const options of [{query:'partial'},{query:'partial token'},{query:'摘要'},{query:'partial',view:'unread'},{query:'partial',view:'blocked'},{query:'partial is:unread'},{query:'partial after:2026-01-03 before:2026-01-18'},{query:'partial feed:"Source A"'},{query:'partial',feedId:a.id},{query:'partial',categoryId:category.id},{query:'partial is:muted'},{query:'partial',view:'unread',tagId:'absent'}]){
   for(const offset of [0,1,20,100,200])compare({...options,offset,limit:13});
   const anchor=legacy(model.db,{...options,offset:5,limit:4}).at(-1);if(anchor)compare({...options,limit:13,cursor:{sortTime:anchor.published_at||anchor.fetched_at,id:anchor.id}});
  }
  assert.ok(fast>20,'must exercise the new ID selection instead of only fallback');
  assert.ok(binary>0,'deep single-term queries must exercise binary membership');
  for(const offset of [850,1000,1199,1800])compare({query:'partial',offset,limit:13});
  assert.ok(binaryTail>0,'dense deep single-term queries must exercise reverse pagination');
  const cursorRow=legacy(model.db,{query:'正文',offset:99,limit:1})[0],beforeCursor=fast;
  compare({query:'正文',limit:100,cursor:{sortTime:cursorRow.published_at||cursorRow.fetched_at,id:cursorRow.id}});
  assert.ok(fast>beforeCursor,'large frequent short-term cursors must use the posting path');
  model.db.exec('BEGIN');model.db.prepare('UPDATE entries SET title=? WHERE id=?').run('partial new',ids[0]);compare({query:'partial',offset:20,limit:13});assert.equal(model.db.isTransaction,true);model.db.exec('ROLLBACK');
  model.db.exec('PRAGMA foreign_keys=OFF');model.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(ids[0]);model.db.exec('PRAGMA foreign_keys=ON');compare({query:'partial',offset:1,limit:13});
 }finally{model.close();rmSync(directory,{recursive:true,force:true});}
});

test('sparse candidates preserve forward, ranked, reverse, partial and empty pages with article/AI overlap',()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-sparse-search-')),model=new RivuDatabase(join(directory,'rivu.db'));
 try{
  const feed=model.addFeed({title:'Sparse source',url:'https://example.invalid/sparse'});
  model.addEntries(feed.id,Array.from({length:6000},(_,i)=>({title:i<1100?'sparsebridge':'noise',content:(i<1050?'commonbridge ':'')+'正文 '+i,hash:String(i),publishedAt:'2026-01-01T00:00:00Z'})));
  const ids=model.db.prepare("SELECT id FROM entries WHERE title='sparsebridge' ORDER BY rowid LIMIT 100").all().map(row=>row.id);
  for(const id of ids)model.saveAI(id,'summary','','local','test','sparsebridge summary','hash','v1');
  let ranked=0,reverse=0;const plans=[];const prepare=model.db.prepare.bind(model.db);model.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('WITH ranked AS')||sql.startsWith('SELECT s.entry_id id FROM rivu_search_entries s NOT INDEXED')){if(sql.startsWith('WITH ranked AS'))ranked++;if(sql.includes('s.sort_time ASC,s.entry_id ASC'))reverse++;const all=statement.all;statement.all=function(...args){plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(...args));return all.apply(this,args);};}return statement;};
  for(const query of ['sparsebridge','sparsebridge commonbridge'])for(const offset of [0,1,450,600,1000,1051,1099,1100,1200])for(const listOnly of [true,false]){
   const options={query,offset,limit:100,listOnly};const actual=model.entries(options);assert.deepEqual(plain(actual),plain(legacy(model.db,options)));assert.equal(new Set(actual.map(row=>row.id)).size,actual.length);
  }
  for(const id of ids)model.updateEntry(id,{read:true});
  for(const offset of [450,600,950,999,1000,1100])for(const listOnly of [true,false]){
   const options={query:'sparsebridge',view:'unread',offset,limit:100,listOnly};assert.deepEqual(plain(model.entries(options)),plain(legacy(model.db,options)));
  }
  assert.ok(ranked>0,'must execute sparse ranking path');
  assert.ok(reverse>0,'must execute reverse pagination');
  assert.ok(plans.every(plan=>plan.some(row=>row.detail.includes('SEARCH s USING INTEGER PRIMARY KEY'))),'sparse ranking must probe candidate integer keys');
  const huge={query:'sparsebridge',offset:1e300,limit:100};assert.throws(()=>legacy(model.db,huge),/datatype mismatch/);assert.throws(()=>model.entries(huge),/datatype mismatch/);
 }finally{model.close();rmSync(directory,{recursive:true,force:true});}
});
