import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {ArchiveReader} from '../dist-server/archive-reader.js';
import {createService} from '../dist-server/service.js';
import {DatabaseSync} from 'node:sqlite';
const worker=resolve('dist-server/archive-read-worker.cjs'),modulePath=resolve('dist-server/archive-read-task.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const deadline=Date.now()+10000;while(!check()){assert.ok(Date.now()<deadline,'读取 Worker 未到达屏障');await delay(10);}}
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-archive-reader-')),db=new RivuDatabase(join(dir,'rivu.db'));
  const archives=db.db.prepare('INSERT INTO permanent_archives VALUES (?,?,?,?,?,?,?,?)'),versions=db.db.prepare('INSERT INTO archive_versions VALUES (?,?,?,?,?)');
  db.db.exec('BEGIN');try{for(let i=0;i<205;i++){const id=String(i).padStart(3,'0');archives.run(id,'entry-'+id,'feed','本地来源','归档 '+id,null,'2026-01-01','2026-01-01');versions.run('v-'+id,id,'hash','<p>中文正文</p>','2026-01-01');}for(let i=0;i<150;i++)versions.run('history-'+i,'204','hash-'+i,'<p>版本 '+i+'</p>','2026-01-01');db.db.exec('COMMIT');}catch(error){db.db.exec('ROLLBACK');throw error;}
  return {dir,db,close:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('guarded archive pages reject concurrent changes, ignore reading changes and stop at exact full pages',async()=>{
  const f=fixture(),service=createService(f.db,'token'),get=url=>service.app.inject({method:'GET',url,headers:{'x-rivu-token':'token'}});
  try{
    const first=(await get('/api/archives/page')).json();assert.equal(first.items.length,100);assert.equal(first.total,205);assert.equal(first.stats.count,205);assert.equal(first.hasNext,true);
    const revision=first.revision;
    for(const offset of [100,200]){const response=await get(`/api/archives/page?offset=${offset}&revision=${revision}`);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().hasNext,offset===100);}
    assert.equal((await get('/api/archives/page?offset=100')).statusCode,400);
    assert.equal((await get('/api/archives/page?revision=bad')).statusCode,400);
    const feed=f.db.addFeed({title:'ordinary',url:'https://example.invalid/rss'});f.db.addEntries(feed.id,[{title:'ordinary',hash:'ordinary',content:'body'}]);f.db.updateEntry(f.db.entries({feedId:feed.id})[0].id,{read:true,starred:true});
    assert.equal((await get(`/api/archives/page?offset=100&revision=${revision}`)).statusCode,200);
    f.db.db.exec("BEGIN; UPDATE permanent_archives SET title='rollback' WHERE id='204'; ROLLBACK");assert.equal((await get('/api/archives/page')).json().revision,revision);
    const mutations=["UPDATE permanent_archives SET title='updated' WHERE id='204'","UPDATE archive_versions SET body_html='updated' WHERE id='history-149'","INSERT INTO archive_assets VALUES ('asset','204','history-149','image','https://example.invalid/image','image/png',1,x'01')","UPDATE archive_assets SET mime='image/jpeg' WHERE id='asset'","DELETE FROM archive_assets WHERE id='asset'"];
    for(const mutation of mutations){const before=(await get('/api/archives/page')).json().revision;f.db.db.exec(mutation);assert.equal((await get(`/api/archives/page?offset=100&revision=${before}`)).statusCode,409);assert.equal((await get(`/api/archives/204/versions/page?offset=100&revision=${before}`)).statusCode,409);assert.equal((await get(`/api/archives/204/versions/history-149?revision=${before}`)).statusCode,409);}
    f.db.db.exec("DELETE FROM permanent_archives WHERE id IN ('000','001','002','003','004')");
    const exact=(await get('/api/archives/page')).json(),last=(await get(`/api/archives/page?offset=100&revision=${exact.revision}`)).json();assert.equal(last.items.length,100);assert.equal(last.hasNext,false);assert.equal(last.total,200);
    const detail=(await get('/api/archives/204')).json(),history=(await get(`/api/archives/204/versions/page?offset=100&revision=${detail.revision}`)).json();assert.equal(history.items.length,51);assert.equal(history.hasNext,false);
  }finally{await service.stop();f.close();}
});
test('v30 migration snapshots and preserves archive bytes; current schema requires revision triggers',async ()=>{
  const f=fixture(),path=f.db.path;f.db.db.prepare('INSERT INTO archive_assets VALUES (?,?,?,?,?,?,?,?)').run('asset','204','history-149','image','https://example.invalid/image','image/png',3,Buffer.from([0,1,255]));
  for(const table of ['permanent_archives','archive_versions','archive_assets'])for(const event of ['insert','update','delete'])f.db.db.exec(`DROP TRIGGER archive_revision_${table}_${event}`);
  f.db.db.exec("DELETE FROM app_meta WHERE key='archive_revision'; PRAGMA user_version=30");f.db.close();
  try{
    assert.throws(()=>new RivuDatabase(path,undefined,true),/不能创建或迁移/);
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.db.prepare('SELECT count(*) n FROM permanent_archives').get().n,205);assert.deepEqual(Buffer.from(upgraded.db.prepare("SELECT data FROM archive_assets WHERE id='asset'").get().data),Buffer.from([0,1,255]));assert.equal(upgraded.db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get().value,'0');upgraded.db.exec("UPDATE permanent_archives SET title='updated' WHERE id='204'");assert.equal(upgraded.db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get().value,'1');}finally{upgraded.close();}
    const snapshots=readdirSync(f.dir).filter(name=>name.startsWith('pre-migration-'));assert.equal(snapshots.length,1);const snapshot=new DatabaseSync(join(f.dir,snapshots[0]),{readOnly:true});try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,30);assert.equal(snapshot.prepare('SELECT count(*) n FROM archive_assets').get().n,1);}finally{snapshot.close();}
    const raw=new DatabaseSync(path);raw.exec('DROP TRIGGER archive_revision_archive_assets_delete');raw.close();await assert.rejects(()=>RivuDatabase.open(path),/archive_revision_archive_assets_delete/);
  }finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('failed v30 revision migration rolls back new triggers and schema version',async ()=>{
  const f=fixture(),path=f.db.path;
  for(const table of ['permanent_archives','archive_versions','archive_assets'])for(const event of ['insert','update','delete'])f.db.db.exec(`DROP TRIGGER archive_revision_${table}_${event}`);
  f.db.db.exec("UPDATE app_meta SET value='invalid' WHERE key='archive_revision'; PRAGMA user_version=30");f.db.close();
  try{await assert.rejects(()=>RivuDatabase.open(path),/归档修订记录无效/);const raw=new DatabaseSync(path);try{assert.equal(raw.prepare('PRAGMA user_version').get().user_version,30);assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'archive_revision_%'").get().n,0);assert.equal(raw.prepare('SELECT count(*) n FROM archive_versions').get().n,355);assert.equal(raw.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get().value,'invalid');}finally{raw.close();}assert.equal(readdirSync(f.dir).filter(name=>name.startsWith('pre-migration-')).length,1);}finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('archive API pages all records and history, checks identifiers and computes exact UTF8 usage in read worker',async()=>{
  const f=fixture(),service=createService(f.db,'token'),request=url=>service.app.inject({method:'GET',url,headers:{'x-rivu-token':'token'}});
  try{
    const pages=await Promise.all([0,100,200].map(async offset=>{const response=await request(`/api/archives?offset=${offset}`);assert.equal(response.statusCode,200,response.body);return response.json();}));
    assert.deepEqual(pages.map(page=>page.length),[100,100,5]);assert.equal(new Set(pages.flat().map(row=>row.id)).size,205);assert.equal(pages[0][0].id,'204');
    const detail=(await request('/api/archives/204')).json();assert.equal(detail.versions.length,100);assert.equal(detail.version_count,151);assert.equal(detail.version_id,'history-149');assert.match(detail.body_html,/149/);
    const old=(await request('/api/archives/204/versions?offset=100')).json();assert.equal(old.length,51);assert.equal(old.at(-1).id,'v-204');
    assert.equal((await request('/api/archives/203/versions/history-149')).statusCode,404);assert.equal((await request('/api/archives/missing')).statusCode,404);
    for(const query of ['limit=101','offset=-1','limit=1.5','offset=9007199254740992'])assert.equal((await request('/api/archives?'+query)).statusCode,400);
    const expected=f.db.db.prepare('SELECT sum(length(CAST(body_html AS BLOB))) bytes FROM archive_versions').get().bytes;
    assert.deepEqual((await request('/api/archives/stats')).json(),{count:205,assets:0,bytes:expected,quotaBytes:1024*1024*1024});
    const bytes=Buffer.from('离线图片');f.db.db.prepare('INSERT INTO archive_assets VALUES (?,?,?,?,?,?,?,?)').run('asset','204','history-149','image','https://example.invalid/img','image/png',bytes.length,bytes);
    assert.equal((await request('/api/archives/204/assets/asset')).json().dataUrl,'data:image/png;base64,'+bytes.toString('base64'));
    assert.equal((await request('/api/archives/203/assets/asset')).statusCode,404);
    f.db.db.prepare('INSERT INTO archive_assets VALUES (?,?,?,?,?,?,?,zeroblob(?))').run('oversized','204','history-149','audio','https://example.invalid/audio','audio/mpeg',26*1024*1024,26*1024*1024);
    assert.equal((await request('/api/archives/204/assets/oversized')).statusCode,413);
  }finally{await service.stop();f.close();}
});
test('archive read snapshot stays coherent while WAL writer commits; queue and stop drain accepted work',async()=>{
  const f=fixture(),gate=new SharedArrayBuffer(8),flags=new Int32Array(gate),custom=join(f.dir,'snapshot-task.cjs');
  writeFileSync(custom,`const {readArchiveSnapshot}=require(${JSON.stringify(modulePath)});exports.readArchiveSnapshot=input=>readArchiveSnapshot(input,()=>{if(input.hold){const flags=new Int32Array(input.gate);Atomics.store(flags,0,1);Atomics.wait(flags,1,0);}});`);
  const reader=new ArchiveReader(worker,custom,1,10000);
  try{
    const first=reader.read({databasePath:f.db.path,kind:'stats',hold:true,gate});await until(()=>Atomics.load(flags,0)===1);
    const second=reader.read({databasePath:f.db.path,kind:'stats'});await assert.rejects(reader.read({databasePath:f.db.path,kind:'stats'}),error=>error.resourceBusy&&error.statusCode===503);
    f.db.db.prepare('DELETE FROM permanent_archives WHERE id=?').run('000');
    let stopped=false;const drain=reader.stop().then(()=>stopped=true);await delay(20);assert.equal(stopped,false);await assert.rejects(reader.read({databasePath:f.db.path,kind:'stats'}),error=>error.statusCode===503);
    Atomics.store(flags,1,1);Atomics.notify(flags,1);assert.equal((await first).count,205);assert.equal((await second).count,204);await drain;
  }finally{Atomics.store(flags,1,1);Atomics.notify(flags,1);await reader.stop();f.close();}
});
test('timed out or crashed read worker is terminated before queue resumes and next task recovers',async()=>{
  const f=fixture(),custom=join(f.dir,'failure-task.cjs');writeFileSync(custom,`const {readArchiveSnapshot}=require(${JSON.stringify(modulePath)});exports.readArchiveSnapshot=input=>{if(input.hold)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);if(input.crash)process.exit(2);return readArchiveSnapshot(input);};`);
  const reader=new ArchiveReader(worker,custom,16,1500);
  try{
    await assert.rejects(reader.read({databasePath:f.db.path,kind:'stats',hold:true}),/超时/);assert.equal((await reader.read({databasePath:f.db.path,kind:'stats'})).count,205);
    await assert.rejects(reader.read({databasePath:f.db.path,kind:'stats',crash:true}),/退出/);assert.equal((await reader.read({databasePath:f.db.path,kind:'stats'})).count,205);
  }finally{await reader.stop();f.close();}
});
test('metadata byte counting preserves CAST BLOB semantics for UTF8, UTF16 and embedded NUL text',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-archive-encoding-')),reader=new ArchiveReader(worker);
  try{for(const encoding of ['UTF-8','UTF-16le']){
    const path=join(dir,encoding+'.db'),db=new DatabaseSync(path);
    try{db.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE permanent_archives(id TEXT); CREATE TABLE archive_versions(body_html TEXT); CREATE TABLE archive_assets(bytes INTEGER); INSERT INTO permanent_archives VALUES ('local');`);
      db.prepare('INSERT INTO archive_versions VALUES (?)').run('中文字😀\0');
      const expected=db.prepare('SELECT length(CAST(body_html AS BLOB)) bytes FROM archive_versions').get().bytes;
      assert.equal((await reader.read({databasePath:path,kind:'stats'})).bytes,expected);
    }finally{db.close();}
  }}finally{await reader.stop();rmSync(dir,{recursive:true,force:true});}
});
