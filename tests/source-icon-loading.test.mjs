import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createBackup,restoreBackup} from '../dist-server/backup.js';
import {createService} from '../dist-server/service.js';
import {createSourceIconCache} from '../dist-server/source-icon-cache.js';
const {RivuDatabase}=createRequire(import.meta.url)('../dist-server/database.cjs');

test('feed metadata omits large icon payloads while snapshot reads bind current local bytes and authorization',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-icon-metadata-')),db=await RivuDatabase.open(join(dir,'rivu.db')),service=createService(db,'token'),headers={'x-rivu-token':'token'};
  const icon='data:image/png;base64,'+Buffer.alloc(65536,9).toString('base64');
  const request=url=>service.app.inject({url,headers});
  try{
    const ids=[];for(let i=0;i<100;i++)ids.push(db.addFeed({title:`源${i}`,url:`https://example.com/${i}`,icon}).id);
    const legacy=await request('/api/feeds'),metadata=await request('/api/feeds?icons=metadata'),rows=metadata.json();
    assert.equal(rows.length,100);assert.ok(rows.every(row=>row.icon===null&&/^[a-f0-9]{64}$/.test(row.iconKey)));
    assert.ok(metadata.body.length<100000);assert.ok(legacy.body.length>8_000_000);
    console.log(JSON.stringify({feeds:100,iconBytes:65536,legacyResponseBytes:Buffer.byteLength(legacy.body),metadataResponseBytes:Buffer.byteLength(metadata.body)}));
    const row=rows.find(row=>row.id===ids[0]),url=`/api/feeds/${row.id}/icon-snapshot?key=${row.iconKey}`;
    assert.equal((await request(url)).json().icon,icon);
    assert.equal((await service.app.inject({url})).statusCode,401);
    assert.equal((await request(`/api/feeds/${row.id}/icon-snapshot?key=bad`)).statusCode,400);
    assert.equal((await request('/api/feeds?icons=all')).statusCode,400);
    db.db.prepare('UPDATE feeds SET icon=? WHERE id=?').run('data:image/png;base64,YWJj',row.id);
    assert.equal((await request(url)).statusCode,409);
    const changed=(await request('/api/feeds?icons=metadata')).json().find(feed=>feed.id===row.id);assert.notEqual(changed.iconKey,row.iconKey);
    assert.equal((await request(`/api/feeds/${row.id}/icon-snapshot?key=${changed.iconKey}`)).json().icon,'data:image/png;base64,YWJj');
    db.db.prepare('UPDATE feeds SET icon=? WHERE id=?').run('https://example.com/remote-icon',row.id);
    assert.equal((await request('/api/feeds?icons=metadata')).json().find(feed=>feed.id===row.id).iconKey,null);
    db.deleteFeed(row.id);assert.equal((await request(url)).statusCode,404);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('fingerprint cache tracks SQL writes, external connections and transaction rollback without persisting triggers',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-icon-invalidation-')),path=join(dir,'rivu.db'),db=await RivuDatabase.open(path);
  const firstIcon='data:image/png;base64,YWJj',secondIcon='data:image/png;base64,ZGVm';
  const metadata=id=>db.feeds(true).find(feed=>feed.id===id);
  try{
    const feed=db.addFeed({title:'源',url:'https://example.com/feed',icon:firstIcon}),firstKey=metadata(feed.id).iconKey;
    assert.ok(firstKey);assert.equal(metadata(feed.id).iconKey,firstKey);
    assert.equal(db.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'rivu_icon_%'").get().n,0);
    assert.equal(db.db.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'rivu_icon_%'").get().n,3);
    db.db.exec('BEGIN');db.db.prepare('UPDATE feeds SET icon=? WHERE id=?').run(secondIcon,feed.id);
    assert.notEqual(metadata(feed.id).iconKey,firstKey,'transaction sees its uncommitted value');
    db.db.exec('ROLLBACK');assert.equal(metadata(feed.id).iconKey,firstKey,'rolled back icon is not retained in cache');
    const external=new DatabaseSync(path);try{external.prepare('UPDATE feeds SET icon=? WHERE id=?').run(secondIcon,feed.id);}finally{external.close();}
    const secondKey=metadata(feed.id).iconKey;assert.notEqual(secondKey,firstKey);
    db.db.prepare('UPDATE feeds SET title=? WHERE id=?').run('改名',feed.id);assert.equal(metadata(feed.id).iconKey,secondKey);assert.equal(metadata(feed.id).title,'改名');
    db.db.prepare('INSERT INTO categories(id,name,created_at) VALUES (?,?,?)').run('category','分类',new Date().toISOString());db.updateFeed(feed.id,{categoryId:'category'});assert.equal(metadata(feed.id).category_name,'分类');
    db.db.prepare('UPDATE categories SET name=? WHERE id=?').run('新分类','category');assert.equal(metadata(feed.id).category_name,'新分类');
    db.addEntries(feed.id,[{title:'文章',hash:'one'}]);const entry=db.entries()[0];assert.equal(metadata(feed.id).unread_count,1);
    db.updateEntry(entry.id,{read:true});assert.equal(metadata(feed.id).unread_count,0);db.updateEntry(entry.id,{read:false});assert.equal(metadata(feed.id).unread_count,1);
    db.setFilterDecision(entry.id,{decision:'mute',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'one'});assert.equal(metadata(feed.id).unread_count,0);
    db.setFilterDecision(entry.id,{decision:'keep',reason:'',criteria:'',provider:'',model:'',content_hash:''});assert.equal(metadata(feed.id).unread_count,1);
    db.db.prepare('UPDATE feeds SET icon=NULL WHERE id=?').run(feed.id);assert.equal(metadata(feed.id).iconKey,null);
    db.db.prepare('UPDATE feeds SET icon=? WHERE id=?').run(firstIcon,feed.id);assert.equal(metadata(feed.id).iconKey,firstKey);
    const zip=join(dir,'icons.zip'),restored=join(dir,'restored');await createBackup(db,dir,zip);await restoreBackup(zip,restored);
    const copy=await RivuDatabase.open(join(restored,'rivu.db'));try{assert.equal(copy.feeds(true)[0].iconKey,firstKey);assert.equal(copy.feed(feed.id).icon,firstIcon);}finally{copy.close();}
    db.deleteFeed(feed.id);assert.equal(db.feeds(true).length,0);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('icon cache coalesces per-source requests, limits concurrency, evicts by count and size and retries failures',async()=>{
  const releases=[];let calls=0,active=0,peak=0;
  const cache=createSourceIconCache(async(id)=>{calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>releases.push(resolve));active--;return id.repeat(4);},{maxEntries:2,maxChars:8,concurrency:2});
  const first=cache.get('a','hash'),same=cache.get('a','hash'),second=cache.get('b','hash'),third=cache.get('c','hash');
  assert.equal(first,same);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(peak,2);
  releases.shift()();await first;await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,3);
  releases.shift()();releases.shift()();await Promise.all([second,third]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await cache.get('b','hash'),'bbbb');assert.equal(calls,3);
  const evicted=cache.get('a','hash');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,4);releases.shift()();await evicted;
  let attempts=0;
  const failing=createSourceIconCache(async()=>{if(++attempts===1)throw Error('temporary');return 'ok';});
  await assert.rejects(failing.get('source','key'),/temporary/);await new Promise(resolve=>setImmediate(resolve));assert.equal(await failing.get('source','key'),'ok');assert.equal(attempts,2);
  let largeCalls=0;const large=createSourceIconCache(async()=>{largeCalls++;return 'x'.repeat(9);},{maxEntries:2,maxChars:8,concurrency:1});
  await large.get('source','key');await new Promise(resolve=>setImmediate(resolve));await large.get('source','key');assert.equal(largeCalls,2,'oversized values are not retained');
});

test('schema28 icon-key migration preserves source data, and cache corruption or insertion failure is recoverable',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-icon-persistence-')),path=join(dir,'rivu.db');let db=await RivuDatabase.open(path),service;
  const icon='data:image/png;base64,YWJj';
  try{
    const feed=db.addFeed({title:'旧来源',url:'https://example.com/feed',icon});db.addEntries(feed.id,[{title:'旧文章',content:'保留正文',hash:'one'}]);db.updateEntry(db.entries()[0].id,{read:true,starred:true,saved:true});
    const oldFeeds=db.db.prepare('SELECT * FROM feeds').all(),oldEntries=db.db.prepare('SELECT * FROM entries').all();
    db.db.exec('DROP TRIGGER feed_icon_keys_update; DROP TABLE feed_icon_keys; PRAGMA user_version=28');db.close();
    db=await RivuDatabase.open(path);assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
    assert.deepEqual(db.db.prepare('SELECT * FROM feeds').all(),oldFeeds);assert.deepEqual(db.db.prepare('SELECT * FROM entries').all(),oldEntries);
    const key=db.feeds(true)[0].iconKey;assert.equal(db.db.prepare('SELECT icon_key FROM feed_icon_keys WHERE feed_id=?').get(feed.id).icon_key,key);
    const snapshot=new DatabaseSync(join(dir,readdirSync(dir).find(name=>name.startsWith('pre-migration-'))),{readOnly:true});try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,28);assert.deepEqual(snapshot.prepare('SELECT * FROM feeds').all(),oldFeeds);}finally{snapshot.close();}
    db.close();const external=new DatabaseSync(path);try{external.prepare('UPDATE feed_icon_keys SET icon_key=? WHERE feed_id=?').run('0'.repeat(64),feed.id);}finally{external.close();}
    db=await RivuDatabase.open(path);service=createService(db,'token');const headers={'x-rivu-token':'token'};
    assert.equal(db.feeds(true)[0].iconKey,'0'.repeat(64));
    const stale=await service.app.inject({url:`/api/feeds/${feed.id}/icon-snapshot?key=${'0'.repeat(64)}`,headers});assert.equal(stale.statusCode,409);
    assert.equal(db.feeds(true)[0].iconKey,key,'snapshot validation invalidates a stale derived cache');assert.equal(db.feed(feed.id).icon,icon);
    db.db.exec("CREATE TRIGGER fail_icon_key BEFORE INSERT ON feed_icon_keys BEGIN SELECT RAISE(ABORT,'fixture cache failure'); END");
    assert.throws(()=>db.addFeed({title:'失败来源',url:'https://example.com/failure',icon}),/fixture cache failure/);
    assert.equal(db.db.prepare('SELECT count(*) n FROM feeds').get().n,1,'source insert rolls back together with its derived key');
    db.db.exec('DROP TRIGGER fail_icon_key');
    db.invalidateFeedIconKey(feed.id);assert.equal(db.feeds(true)[0].iconKey,key,'missing cache row is rebuilt from the preserved image');
  }finally{await service?.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('schema29 covering index migration preserves rows and rolls back failed index creation',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-feed-index-')),path=join(dir,'rivu.db');let db=await RivuDatabase.open(path);
  try{
    const feed=db.addFeed({title:'索引迁移源',url:'https://example.com/index',icon:'data:image/png;base64,YWJj'});
    db.addEntries(feed.id,[{title:'保留文章',content:'保留正文',hash:'index-one'}]);db.updateEntry(db.entries()[0].id,{read:true,starred:true,saved:true});
    const feeds=db.db.prepare('SELECT * FROM feeds').all(),entries=db.db.prepare('SELECT * FROM entries').all(),keys=db.db.prepare('SELECT * FROM feed_icon_keys').all();
    db.db.exec('DROP INDEX feeds_metadata; PRAGMA user_version=29');db.close();
    db=await RivuDatabase.open(path);
    assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
    assert.deepEqual(db.db.prepare('SELECT * FROM feeds').all(),feeds);assert.deepEqual(db.db.prepare('SELECT * FROM entries').all(),entries);assert.deepEqual(db.db.prepare('SELECT * FROM feed_icon_keys').all(),keys);
    const columns=db.db.prepare('PRAGMA table_info(feeds)').all().map(row=>row.name).filter(name=>name!=='icon');
    const plan=db.db.prepare(`EXPLAIN QUERY PLAN SELECT ${columns.map(name=>'f.'+name).join(',')},c.name FROM feeds f LEFT JOIN categories c ON c.id=f.category_id ORDER BY f.title COLLATE NOCASE`).all();
    assert.ok(plan.some(row=>row.detail.includes('COVERING INDEX feeds_metadata')));
    const snapshot=new DatabaseSync(join(dir,readdirSync(dir).find(name=>name.startsWith('pre-migration-'))),{readOnly:true});
    try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,29);assert.deepEqual(snapshot.prepare('SELECT * FROM feeds').all(),feeds);assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='feeds_metadata'").get(),undefined);}finally{snapshot.close();}
    db.db.exec('DROP INDEX feeds_metadata; CREATE TABLE feeds_metadata(value TEXT); PRAGMA user_version=29');db.close();
    await assert.rejects(()=>RivuDatabase.open(path),/feeds_metadata/);
    const failed=new DatabaseSync(path);try{assert.equal(failed.prepare('PRAGMA user_version').get().user_version,29);assert.deepEqual(failed.prepare('SELECT * FROM feeds').all(),feeds);assert.deepEqual(failed.prepare('SELECT * FROM entries').all(),entries);failed.exec('DROP TABLE feeds_metadata');}finally{failed.close();}
    db=await RivuDatabase.open(path);assert.equal(db.feeds(true)[0].title,feed.title);assert.equal(db.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('refresh selection omits icons and counts while preserving paused, manual-only, future and recovered source behavior',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-refresh-selection-')),db=await RivuDatabase.open(join(dir,'rivu.db'));let service;
  const requested=[];const origin=createServer((req,res)=>{requested.push(req.url);res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>本地源</title><item><guid>${req.url}</guid><title>本地文章</title></item></channel></rss>`);});
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${origin.address().port}`,icon='data:image/png;base64,'+Buffer.alloc(256*1024,9).toString('base64');
  try{
    const due=db.addFeed({title:'到期',url:base+'/due',allowPrivate:true,icon});
    const manual=db.addFeed({title:'仅手动',url:base+'/manual',allowPrivate:true,fetchInterval:0,icon});
    const future=db.addFeed({title:'未到期',url:base+'/future',allowPrivate:true,icon});
    const paused=db.addFeed({title:'暂停',url:base+'/paused',allowPrivate:true,icon});
    const recovered=db.addFeed({title:'恢复占位',url:base+'/recovered',icon});
    db.db.prepare('UPDATE feeds SET next_fetch_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z',future.id);db.updateFeed(paused.id,{enabled:false});
    db.db.prepare('UPDATE feeds SET url=? WHERE id=?').run('https://recovered.invalid/feed/fixture',recovered.id);
    assert.deepEqual(db.dueFeeds().map(feed=>feed.id),[due.id]);
    const selected=db.refreshableFeeds();assert.deepEqual(new Set(selected.map(feed=>feed.id)),new Set([due.id,manual.id,future.id]));
    assert.ok(selected.every(feed=>Object.keys(feed).sort().join(',')==='id,url'));
    const originalFeeds=db.feeds;db.feeds=()=>{throw Error('refresh must not load display metadata or image payloads');};
    service=createService(db,'token');const result=await service.app.inject({method:'POST',url:'/api/feeds/refresh',headers:{'x-rivu-token':'token'}});
    assert.equal(result.statusCode,200,result.body);assert.equal(result.json().total,3);assert.equal(result.json().succeeded,3);assert.equal(result.json().failed,0);
    assert.deepEqual(new Set(requested),new Set(['/due','/manual','/future']));db.feeds=originalFeeds;
    assert.equal(db.feed(due.id).icon,icon);assert.equal(db.feed(manual.id).fetch_interval,0);assert.equal(db.feed(paused.id).enabled,0);
    assert.equal(db.feed(due.id).failure_count,0);assert.ok(db.feed(due.id).last_success_at);assert.equal(db.dueFeeds().length,0);
  }finally{await service?.stop();db.close();await new Promise(resolve=>origin.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
