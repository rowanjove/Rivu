import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {buildSync} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {validateUnreadCounts,unreadCountTriggerNames} from '../dist-server/unread-counts.js';
const require=createRequire(import.meta.url);
const articleRows=db=>db.prepare('SELECT * FROM entries ORDER BY id').all();
const derivedSchema=db=>db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'rivu_%' ORDER BY type,name").all();
function legacy37(){
 assert.equal(createHash('sha256').update(readFileSync('tests/fixtures/schema37-unread.ts')).digest('hex'),'954b8853f13ffe1e38e5dcfda6a5d638317537dcecc1e2e50ef07e1302705e7e');
 const directory=mkdtempSync(join(tmpdir(),'rivu-source37-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),outfile=join(directory,'old.cjs');
 try{
  const feed=db.addFeed({title:'Original',url:'https://example.invalid/source37'});db.addEntries(feed.id,[{title:'Article',content:'原始😀\u0000字节',hash:'one'}]);
  const id=db.entries()[0].id;db.updateEntry(id,{read:true});
  buildSync({entryPoints:['tests/fixtures/schema37-unread.ts'],outfile,bundle:true,platform:'node',format:'cjs'});
  db.db.exec('BEGIN');for(const name of unreadCountTriggerNames)db.db.exec(`DROP TRIGGER ${name}`);
  db.db.exec('DROP TABLE IF EXISTS rivu_raw_unread_entries;DROP TABLE rivu_entry_visibility; DROP TABLE rivu_feed_unread_counts; DROP TABLE rivu_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_feed_timeline_bucket_counts; DROP TABLE IF EXISTS rivu_category_timeline_bucket_counts; DROP TABLE rivu_source_entry_counts');
  require(outfile).installUnreadCounts(db.db);db.db.exec('PRAGMA user_version=37; COMMIT');
  return {directory,path,articles:articleRows(db.db),schema:derivedSchema(db.db),close(){rmSync(directory,{recursive:true,force:true});}};
 }finally{db.close();}
}

test('genuine schema37 gains compact indexes and source counts while preserving its snapshot and articles',async ()=>{
 const f=legacy37();let db;
 try{
  db=await RivuDatabase.open(f.path);assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(articleRows(db.db),f.articles);validateUnreadCounts(db.db);
  assert.equal(db.db.prepare('SELECT sum(entry_count) n FROM rivu_source_entry_counts').get().n,1);
  assert.deepEqual(db.db.prepare('PRAGMA index_info(rivu_visibility_timeline)').all().map(r=>r.name),['blocked','sort_bucket','sort_time','entry_id']);
  const files=readdirSync(f.directory).filter(n=>n.startsWith('pre-migration-'));assert.equal(files.length,1);
  const old=new DatabaseSync(join(f.directory,files[0]),{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,37);assert.deepEqual(articleRows(old),f.articles);assert.deepEqual(derivedSchema(old),f.schema);assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name='rivu_source_entry_counts'").get(),undefined);}finally{old.close();}
  db.close();db=await RivuDatabase.open(f.path);assert.equal(readdirSync(f.directory).filter(n=>n.startsWith('pre-migration-')).length,1);
 }finally{db?.close();f.close();}
});

test('schema37 source-count migration rolls back table, index and trigger changes on failed verification',async ()=>{
 const f=legacy37(),prepare=DatabaseSync.prototype.prepare;let db;
 try{
  DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA integrity_check')throw Error('source count verification failure');return prepare.call(this,sql);};
  await assert.rejects(()=>RivuDatabase.open(f.path),/source count verification failure/);DatabaseSync.prototype.prepare=prepare;
  const old=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,37);assert.deepEqual(articleRows(old),f.articles);assert.deepEqual(derivedSchema(old),f.schema);}finally{old.close();}
  db=await RivuDatabase.open(f.path);validateUnreadCounts(db.db);
 }finally{DatabaseSync.prototype.prepare=prepare;db?.close();f.close();}
});

test('source counts preserve orphan detection, moves, cascades and rollback while read-only changes do not write them',async ()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-source-counts-')),db=await RivuDatabase.open(join(directory,'rivu.db'));
 const check=()=>{const expected=db.db.prepare('SELECT feed_id,count(*) entry_count FROM entries GROUP BY feed_id ORDER BY feed_id').all();assert.deepEqual(db.db.prepare('SELECT * FROM rivu_source_entry_counts ORDER BY feed_id').all(),expected);validateUnreadCounts(db.db);};
 try{
  const a=db.addFeed({title:'A',url:'https://example.invalid/source-a'}),b=db.addFeed({title:'B',url:'https://example.invalid/source-b'});
  db.addEntries(a.id,Array.from({length:5},(_,i)=>({title:'A'+i,hash:'a'+i,publishedAt:'2026-01-01'})));db.addEntries(b.id,[{title:'B',hash:'b',publishedAt:'2027-01-01'}]);check();
  const id=db.entries({feedId:a.id})[0].id;db.db.exec('DELETE FROM entry_identities');
  db.db.exec("CREATE TRIGGER reject_catalog_update AFTER UPDATE ON rivu_source_entry_counts BEGIN SELECT RAISE(ABORT,'catalog update failure'); END");
  db.db.prepare('UPDATE entries SET read=1 WHERE id=?').run(id);check();
  assert.throws(()=>db.db.prepare('UPDATE entries SET feed_id=? WHERE id=?').run(b.id,id),/catalog update failure/);check();assert.equal(db.entry(id).feed_id,a.id);
  db.db.exec('DROP TRIGGER reject_catalog_update');db.db.exec('BEGIN');db.db.prepare('UPDATE entries SET feed_id=? WHERE id=?').run(b.id,id);check();db.db.exec('ROLLBACK');check();
  db.db.prepare('UPDATE entries SET feed_id=? WHERE id=?').run(b.id,id);check();
  assert.throws(()=>db.db.prepare('UPDATE feeds SET id=? WHERE id=?').run('renamed-source',a.id),/FOREIGN KEY/);check();
  db.db.exec('PRAGMA foreign_keys=OFF');db.db.prepare('UPDATE feeds SET id=? WHERE id=?').run('renamed-source',a.id);check();
  db.db.prepare('UPDATE entries SET feed_id=? WHERE feed_id=?').run('renamed-source',a.id);check();db.db.exec('PRAGMA foreign_keys=ON');
  db.db.exec('PRAGMA foreign_keys=OFF');db.db.prepare('DELETE FROM feeds WHERE id=?').run(b.id);check();assert.equal(db.db.prepare('SELECT entry_count FROM rivu_source_entry_counts WHERE feed_id=?').get(b.id).entry_count,2);
  const expected=db.db.prepare('SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 100 OFFSET 1').all().map(r=>r.id);
  assert.deepEqual(db.entries({offset:1,listOnly:true}).map(r=>r.id),expected);
  db.db.prepare('DELETE FROM entries WHERE feed_id=?').run(b.id);check();assert.equal(db.db.prepare('SELECT * FROM rivu_source_entry_counts WHERE feed_id=?').get(b.id),undefined);
  db.db.exec('PRAGMA foreign_keys=ON');db.deleteFeed('renamed-source');check();assert.equal(db.db.prepare('SELECT count(*) n FROM rivu_source_entry_counts').get().n,0);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('source count corruption is detected by semantic validation',async ()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-source-corrupt-')),db=await RivuDatabase.open(join(directory,'rivu.db'));
 try{const feed=db.addFeed({title:'Source',url:'https://example.invalid/source-corrupt'});db.addEntries(feed.id,[{title:'Article',hash:'a'}]);db.db.exec('UPDATE rivu_source_entry_counts SET entry_count=2');assert.throws(()=>validateUnreadCounts(db.db),/来源条目计数/);db.db.exec('DELETE FROM rivu_source_entry_counts');assert.throws(()=>validateUnreadCounts(db.db),/来源条目计数/);}finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
