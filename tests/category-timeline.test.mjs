import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {validateUnreadCounts,unreadCountTriggerNames} from '../dist-server/unread-counts.js';
import {queryEntries as legacy} from './fixtures/schema36-entry-query.mjs';
const require=createRequire(import.meta.url),plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-category-buckets-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path);
 const a=db.addCategory('A'),b=db.addCategory('B'),feeds=[a.id,a.id,b.id,null].map((categoryId,i)=>db.addFeed({title:'Selected '+i,url:'https://example.invalid/category/'+i,categoryId,fetchInterval:0}));
 db.db.exec('BEGIN');const insert=db.db.prepare('INSERT INTO entries(id,feed_id,title,content,hash,published_at,fetched_at) VALUES (?,?,?,?,?,?,?)');
 for(let i=0;i<240;i++)insert.run(randomUUID(),feeds[i%4].id,'Category '+i,'<p>原始 😀\u0000'+i+'</p>','category-'+i,new Date(Date.UTC(2020,0,1)+i*86400000).toISOString(),'2026-01-01');db.db.exec('COMMIT');
 return {directory,path,db,a,b,feeds,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
function raw(db){return db.prepare('SELECT *,hex(CAST(content AS BLOB)) raw_content,hex(CAST(full_content AS BLOB)) raw_full_content FROM entries ORDER BY id').all();}
function schema(db){return db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'rivu_%' ORDER BY type,name").all();}
function check(f){
 validateUnreadCounts(f.db.db);
 for(const categoryId of [f.a.id,f.b.id])for(const view of ['all','unread','blocked'])for(const query of [undefined,'after:2020-02-01 before:2020-07-01','feed:Selected','is:unread'])for(const offset of [0,1,17,100,300])for(const listOnly of [true,false]){const opts={categoryId,view,query,offset,limit:17,listOnly};assert.deepEqual(plain(f.db.entries(opts)),plain(legacy(f.db.db,opts)),JSON.stringify(opts));}
}
function old40(){
 const f=fixture(),module=join(f.directory,'schema40.cjs');assert.equal(createHash('sha256').update(readFileSync('tests/fixtures/schema40-unread.ts')).digest('hex'),'162540c8486a2f0cfbdac77b5f1a40da34bcd04cb792ef16cac88a791bd810da');
 buildSync({entryPoints:['tests/fixtures/schema40-unread.ts'],outfile:module,bundle:true,platform:'node',format:'cjs'});
 f.db.db.exec('BEGIN');for(const name of unreadCountTriggerNames)f.db.db.exec(`DROP TRIGGER ${name}`);
 f.db.db.exec('DROP TABLE IF EXISTS rivu_raw_unread_entries;DROP TABLE rivu_entry_visibility;DROP TABLE rivu_feed_unread_counts;DROP TABLE rivu_source_entry_counts;DROP TABLE rivu_timeline_bucket_counts;DROP TABLE rivu_feed_timeline_bucket_counts;DROP TABLE rivu_category_timeline_bucket_counts');
 require(module).installUnreadCounts(f.db.db);f.db.db.exec('PRAGMA user_version=40;COMMIT');const result={...f,rows:raw(f.db.db),schema:schema(f.db.db)};f.db.close();return result;
}
test('genuine40 migration clusters counters, backfills categories and retains the original snapshot and article bytes',async ()=>{
 const f=old40();let db;try{
  db=await RivuDatabase.open(f.path);assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(raw(db.db),f.rows);validateUnreadCounts(db.db);
  for(const name of ['rivu_feed_timeline_bucket_counts','rivu_category_timeline_bucket_counts'])assert.equal(db.db.prepare('SELECT wr FROM pragma_table_list WHERE name=?').get(name).wr,1);
  assert.ok(db.db.prepare('EXPLAIN QUERY PLAN UPDATE rivu_feed_timeline_bucket_counts SET category_id=? WHERE feed_id=?').all(f.b.id,f.feeds[0].id).some(row=>/SEARCH rivu_feed_timeline_bucket_counts USING INDEX rivu_source_bucket_feed.*feed_id=/.test(row.detail)),'category reassignment must seek the source bucket index');
  const files=readdirSync(f.directory).filter(n=>n.startsWith('pre-migration-'));assert.equal(files.length,1);const old=new DatabaseSync(join(f.directory,files[0]),{readOnly:true});
  try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,40);assert.deepEqual(raw(old),f.rows);assert.deepEqual(schema(old),f.schema);assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name='rivu_category_timeline_bucket_counts'").get(),undefined);assert.equal(old.prepare("SELECT wr FROM pragma_table_list WHERE name='rivu_feed_timeline_bucket_counts'").get().wr,0);}finally{old.close();}
  db.close();db=await RivuDatabase.open(f.path);assert.equal(readdirSync(f.directory).filter(n=>n.startsWith('pre-migration-')).length,1);
 }finally{db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('late40 migration failure restores old counters, trigger definitions, version and raw fields before retry',async ()=>{
 const f=old40(),prepare=DatabaseSync.prototype.prepare;let db;try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('category migration integrity failure');return prepare.call(this,sql);};await assert.rejects(()=>RivuDatabase.open(f.path),/category migration integrity failure/);DatabaseSync.prototype.prepare=prepare;
  const old=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,40);assert.deepEqual(raw(old),f.rows);assert.deepEqual(schema(old),f.schema);}finally{old.close();}
  db=await RivuDatabase.open(f.path);validateUnreadCounts(db.db);
 }finally{DatabaseSync.prototype.prepare=prepare;db?.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('category counters follow read, rules, AI, source/date moves and category reassignment without rewriting visibility on metadata edits',()=>{
 const f=fixture();try{
  check(f);const id=f.db.db.prepare('SELECT id FROM entries LIMIT 1').get().id;f.db.updateEntry(id,{read:true});check(f);
  f.db.db.exec("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES ('cb','Block','{}','block','2026','2026'),('cm','Mute','{}','mute','2026','2026');INSERT INTO rule_matches SELECT 'cb',id,'2026' FROM entries WHERE rowid%5=0;INSERT INTO rule_matches SELECT 'cm',id,'2026' FROM entries WHERE rowid%7=0");check(f);
  f.db.setFilterDecision(id,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'fixture'});check(f);
  f.db.db.prepare('DELETE FROM entry_identities WHERE entry_id=?').run(id);f.db.db.prepare('UPDATE entries SET feed_id=?,published_at=? WHERE id=?').run(f.feeds[2].id,'2030-01-01',id);check(f);
  const before=raw(f.db.db);for(const event of ['INSERT','UPDATE','DELETE'])f.db.db.exec(`CREATE TRIGGER reject_visibility_${event} AFTER ${event} ON rivu_entry_visibility BEGIN SELECT RAISE(ABORT,'metadata rewrote visibility');END`);
  f.db.updateFeed(f.feeds[0].id,{categoryId:f.b.id});check(f);f.db.updateFeed(f.feeds[1].id,{categoryId:null});check(f);assert.deepEqual(raw(f.db.db),before);
  for(const event of ['INSERT','UPDATE','DELETE'])f.db.db.exec(`DROP TRIGGER reject_visibility_${event}`);
  const counters=f.db.db.prepare('SELECT * FROM rivu_category_timeline_bucket_counts ORDER BY category_id,sort_bucket').all();f.db.db.exec('SAVEPOINT category');f.db.updateFeed(f.feeds[3].id,{categoryId:f.a.id});check(f);f.db.db.exec('ROLLBACK TO category;RELEASE category');assert.deepEqual(f.db.db.prepare('SELECT * FROM rivu_category_timeline_bucket_counts ORDER BY category_id,sort_bucket').all(),counters);check(f);
 }finally{f.close();}
});
test('category counters retain correct deletion and orphan semantics for feed replacement, ID changes and category cascades',()=>{
 const f=fixture();try{
  const feed=f.feeds[0];f.db.db.prepare('INSERT OR REPLACE INTO feeds(id,title,url,category_id,created_at) VALUES (?,?,?,?,?)').run(feed.id,'Replacement',feed.url,f.b.id,'2026');check(f);
  f.db.db.exec('PRAGMA foreign_keys=OFF');f.db.db.prepare('DELETE FROM feeds WHERE id=?').run(f.feeds[1].id);check(f);
  f.db.db.prepare('INSERT INTO feeds(id,title,url,category_id,created_at) VALUES (?,?,?,?,?)').run(f.feeds[1].id,'Reattached',f.feeds[1].url,f.b.id,'2026');check(f);
  f.db.db.prepare('UPDATE feeds SET id=? WHERE id=?').run(randomUUID(),f.feeds[1].id);check(f);f.db.db.exec('PRAGMA foreign_keys=ON');
  f.db.deleteFeed(f.feeds[2].id);check(f);f.db.db.prepare('DELETE FROM categories WHERE id=?').run(f.a.id);check(f);
 }finally{f.close();}
});
test('injected category counter failure rolls back article writes and source metadata atomically',()=>{
 const f=fixture();try{
  const id=f.db.db.prepare('SELECT id FROM entries WHERE feed_id=? LIMIT 1').get(f.feeds[0].id).id,before=raw(f.db.db),category=f.db.feed(f.feeds[0].id).category_id;
  f.db.db.exec("CREATE TRIGGER reject_category_update AFTER UPDATE ON rivu_category_timeline_bucket_counts BEGIN SELECT RAISE(ABORT,'category counter failure');END");assert.throws(()=>f.db.updateEntry(id,{read:true}),/category counter failure/);assert.deepEqual(raw(f.db.db),before);check(f);f.db.db.exec('DROP TRIGGER reject_category_update');
  f.db.db.exec("CREATE TRIGGER reject_category_insert AFTER INSERT ON rivu_category_timeline_bucket_counts BEGIN SELECT RAISE(ABORT,'category counter failure');END");assert.throws(()=>f.db.updateFeed(f.feeds[0].id,{categoryId:f.b.id}),/category counter failure/);assert.equal(f.db.feed(f.feeds[0].id).category_id,category);assert.deepEqual(raw(f.db.db),before);check(f);f.db.db.exec('DROP TRIGGER reject_category_insert');
  f.db.updateEntry(id,{read:true});f.db.updateFeed(f.feeds[0].id,{categoryId:f.b.id});check(f);
 }finally{f.close();}
});
test('category deep offsets use a primary-key category range instead of aggregating source buckets',()=>{
 const f=fixture();try{
  const prepare=f.db.db.prepare.bind(f.db.db);let categoryRange=false,sourceAggregate=false;
  f.db.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('FROM rivu_feed_timeline_bucket_counts WHERE')&&sql.includes('SUM('))sourceAggregate=true;if(sql.includes('FROM rivu_category_timeline_bucket_counts WHERE')){const iterate=statement.iterate;statement.iterate=function(...args){categoryRange||=prepare('EXPLAIN QUERY PLAN '+sql).all(...args).some(row=>/SEARCH rivu_category_timeline_bucket_counts USING PRIMARY KEY.*category_id=/.test(row.detail));return iterate.apply(this,args);};}return statement;};
  for(const view of ['all','unread','blocked'])for(const query of [undefined,'after:2020-02-01 before:2020-08-01']){const opts={categoryId:f.a.id,view,query,offset:17,limit:17,listOnly:true};assert.deepEqual(plain(f.db.entries(opts)),plain(legacy(f.db.db,opts)));}
  assert.ok(categoryRange);assert.equal(sourceAggregate,false);f.db.db.prepare=prepare;
 }finally{f.close();}
});
test('current schema rejects unclustered category counters and semantic category corruption',async ()=>{
 const f=fixture();let closed=false;try{
  f.db.db.exec('UPDATE rivu_category_timeline_bucket_counts SET entry_count=entry_count+1');assert.throws(()=>validateUnreadCounts(f.db.db),/分类时间分桶计数/);
  f.db.db.exec('CREATE TABLE category_copy AS SELECT * FROM rivu_category_timeline_bucket_counts;DROP TABLE rivu_category_timeline_bucket_counts;CREATE TABLE rivu_category_timeline_bucket_counts(category_id TEXT NOT NULL,sort_bucket TEXT NOT NULL,entry_count INTEGER,visible_count INTEGER,blocked_count INTEGER,PRIMARY KEY(category_id,sort_bucket));INSERT INTO rivu_category_timeline_bucket_counts SELECT * FROM category_copy');
  f.db.close();closed=true;await assert.rejects(()=>RivuDatabase.open(f.path),/分桶聚簇结构无效/);
 }finally{if(!closed)f.db.close();rmSync(f.directory,{recursive:true,force:true});}
});
test('universal source-name filters use scope counts; partial source filters retain clustered aggregation without a temporary group sort',()=>{
 const f=fixture();try{
  const prepare=f.db.db.prepare.bind(f.db.db);let allowAggregate=false,sawClustered=false;
  f.db.db.prepare=sql=>{
   const statement=prepare(sql);if(sql.includes('SUM(')&&sql.includes('FROM rivu_feed_timeline_bucket_counts')){
    assert.ok(allowAggregate,'universal source filters must not reaggregate every source bucket');
    const iterate=statement.iterate;statement.iterate=function(...args){const plan=prepare('EXPLAIN QUERY PLAN '+sql).all(...args);assert.equal(plan.some(row=>/USE TEMP B-TREE FOR GROUP BY/.test(row.detail)),false);assert.equal(plan.some(row=>/USING INDEX rivu_source_bucket_feed/.test(row.detail)),false);sawClustered=true;return iterate.apply(this,args);};
   }return statement;
  };
  for(const categoryId of [undefined,f.a.id])for(const view of ['all','unread','blocked'])for(const query of ['feed:Selected','feed:Selected after:2020-02-01 before:2020-07-01']){
   const opts={categoryId,view,query,offset:17,limit:17,listOnly:true};assert.deepEqual(plain(f.db.entries(opts)),plain(legacy(f.db.db,opts)));
  }
  allowAggregate=true;for(const categoryId of [undefined,f.a.id]){const opts={categoryId,query:'feed:"Selected 0"',offset:17,limit:17,listOnly:true};assert.deepEqual(plain(f.db.entries(opts)),plain(legacy(f.db.db,opts)));}assert.ok(sawClustered);f.db.db.prepare=prepare;
 }finally{f.close();}
});
