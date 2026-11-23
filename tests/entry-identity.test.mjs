import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { refreshFeed } from '../dist-server/feeds.js';
import { saveArchive,getArchive } from '../dist-server/archive.js';
import { createBackup,restoreBackup } from '../dist-server/backup.js';
import { createService } from '../dist-server/service.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
const setup=()=>{const dir=mkdtempSync(join(tmpdir(),'rivu-identities-'));return {dir,path:join(dir,'rivu.db'),db:new RivuDatabase(join(dir,'rivu.db'))};};

test('URL and canonical aliases preserve stable article state across changed GUIDs and tracking URLs, scoped to each feed',async()=>{
  const {dir,db}=setup();
  try{
    const feed=db.addFeed({title:'来源',url:'https://example.com/feed'}),input={title:'文章',guid:'guid-one',url:'https://example.com/post?lang=zh&utm_source=one#section',content:'原正文',hash:'hash-one'};
    assert.equal(db.addEntries(feed.id,[input]),1);const entry=db.entries()[0];db.updateEntry(entry.id,{read:true,starred:true,saved:true});db.saveReadingPosition(entry.id,0.7);const tag=db.addTag('标签');db.setEntryTags(entry.id,[tag.id]);db.saveAI(entry.id,'summary','zh-CN','local','model','本地摘要');
    const archive=await saveArchive(db,entry.id,{});
    assert.equal(db.addEntries(feed.id,[{...input,guid:'guid-two',url:'https://example.com/post?utm_medium=new&lang=zh',content:'新抓取内容',hash:'hash-two'}]),0);
    const retained=db.entry(entry.id);assert.equal(retained.read,1);assert.equal(retained.starred,1);assert.equal(retained.saved,1);assert.equal(retained.content,'原正文');assert.equal(db.entryTags(entry.id)[0].id,tag.id);assert.equal(db.readingPosition(entry.id).progress,0.7);assert.equal(db.aiResult(entry.id,'summary','zh-CN').content,'本地摘要');assert.equal(getArchive(db,archive.id).title,'文章');
    assert.equal(db.addEntries(feed.id,[{...input,guid:'guid-two',url:'https://example.com/renamed',hash:'hash-three'}]),0,'新GUID也应成为后续别名');
    assert.equal(db.addEntries(feed.id,[{...input,guid:'guid-three',url:'https://example.com/post?lang=en',hash:'other-language'}]),1,'语义参数必须保留');
    const other=db.addFeed({title:'另一来源',url:'https://example.org/feed'});assert.equal(db.addEntries(other.id,[input]),1);
    assert.throws(()=>db.db.prepare('INSERT INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)').run(other.id,entry.id,'guid','forged'),/FOREIGN KEY/,'数据库约束必须拒绝跨订阅别名');
    const backup=join(dir,'identity.zip'),restored=join(dir,'restored');await createBackup(db,dir,backup);await restoreBackup(backup,restored);const copy=await RivuDatabase.open(join(restored,'rivu.db'));
    try{assert.equal(copy.addEntries(feed.id,[{...input,guid:'guid-four',url:'https://example.com/post?lang=zh',hash:'four'}]),0);assert.equal(copy.entry(entry.id).starred,1);}finally{copy.close();}
    db.deleteFeed(feed.id);assert.equal(db.db.prepare('SELECT count(*) n FROM entry_identities WHERE feed_id=?').get(feed.id).n,0);assert.equal(getArchive(db,archive.id).title,'文章');assert.equal(db.entries({feedId:other.id}).length,1);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('body fallback distinguishes dates, explicit URLs and distinct Newsletter message IDs',()=>{
  const {dir,db}=setup();try{
    const feed=db.addFeed({title:'正文来源',url:'https://example.com/body'}),base={title:'相同标题',content:'相同正文',author:'作者'};
    assert.equal(db.addEntries(feed.id,[{...base,guid:'first',hash:'first',publishedAt:'2026-10-01T00:00:00Z'}]),1);
    assert.equal(db.addEntries(feed.id,[{...base,guid:'changed',hash:'changed',publishedAt:'2026-10-01T08:00:00+08:00'}]),0);
    assert.equal(db.addEntries(feed.id,[{...base,guid:'tomorrow',hash:'tomorrow',publishedAt:'2026-10-02T00:00:00Z'}]),1);
    assert.equal(db.addEntries(feed.id,[{...base,guid:'url-a',url:'https://example.com/a',hash:'url-a'},{...base,guid:'url-b',url:'https://example.com/b',hash:'url-b'}]),2);
    const newsletter=db.addFeed({title:'邮件',url:'newsletter:///identity',type:'newsletter'});assert.equal(db.addEntries(newsletter.id,[{...base,guid:'mail-a',hash:'mail-a'},{...base,guid:'mail-b',hash:'mail-b'}]),2);
    assert.equal(db.addEntries(feed.id,[{title:'空正文',hash:'empty-a'},{title:'空正文',hash:'empty-b'}]),2);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('conflicting strong identifiers roll back the entire batch without merging records or states',()=>{
  const {dir,db}=setup();try{
    const feed=db.addFeed({title:'冲突',url:'https://example.com/conflict'});db.addEntries(feed.id,[{title:'A',guid:'a',url:'https://example.com/a',hash:'a'},{title:'B',guid:'b',url:'https://example.com/b',hash:'b'}]);const before=db.db.prepare('SELECT * FROM entries ORDER BY id').all(),aliases=db.db.prepare('SELECT * FROM entry_identities ORDER BY entry_id,kind,value').all();
    assert.throws(()=>db.addEntries(feed.id,[{title:'正常新项',guid:'new',hash:'new'},{title:'错误项',guid:'a',url:'https://example.com/b',hash:'wrong'}]),/标识存在冲突/);
    assert.deepEqual(db.db.prepare('SELECT * FROM entries ORDER BY id').all(),before);assert.deepEqual(db.db.prepare('SELECT * FROM entry_identities ORDER BY entry_id,kind,value').all(),aliases);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('canonical normalization preserves query order, and conflicting full-text declarations cannot create ambiguity',()=>{
  const {dir,db}=setup();try{
    const feed=db.addFeed({title:'查询参数',url:'https://example.com/feed'});
    assert.equal(db.addEntries(feed.id,[{title:'操作A',guid:'order-a',url:'https://example.com/action?first=1&second=2',hash:'order-a'},{title:'操作B',guid:'order-b',url:'https://example.com/action?second=2&first=1',hash:'order-b'}]),2);
    db.addEntries(feed.id,[{title:'A',guid:'a',url:'https://example.com/a',hash:'a'},{title:'B',guid:'b',url:'https://example.com/b',hash:'b'}]);const a=db.entries().find(row=>row.title==='A'),b=db.entries().find(row=>row.title==='B');db.updateEntry(b.id,{read:true,starred:true});
    db.setFullContent(a.id,'<p>A全文仍然保存</p>','https://example.com/b');
    assert.equal(db.entry(a.id).full_content,'<p>A全文仍然保存</p>');assert.deepEqual(db.db.prepare("SELECT entry_id FROM entry_identities WHERE feed_id=? AND kind='canonical' AND value='https://example.com/b'").all(feed.id).map(row=>row.entry_id),[b.id]);
    assert.equal(db.addEntries(feed.id,[{title:'新C',guid:'c',url:'https://example.com/c',hash:'c'},{title:'B变化',guid:'changed-b',url:'https://example.com/b?utm_source=new',hash:'changed-b'}]),1);
    assert.equal(db.entry(b.id).read,1);assert.equal(db.entry(b.id).starred,1);assert.equal(db.entries().length,5);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('v26 identity migration preserves duplicate legacy rows and all their data, keeps a rollback snapshot',async ()=>{
  const {dir,path,db}=setup();let upgraded;
  try{
    const feed=db.addFeed({title:'旧来源',url:'https://example.com/old'});db.addEntries(feed.id,[{title:'旧A',guid:'old-a',url:'https://example.com/post?utm_source=a',content:'A正文',hash:'a'}]);const id=db.entries()[0].id;db.updateEntry(id,{read:true,saved:true,starred:true});
    db.db.prepare('INSERT INTO entries(id,feed_id,guid,title,url,fetched_at,content,hash) VALUES (?,?,?,?,?,?,?,?)').run('legacy-b',feed.id,'old-b','旧B','https://example.com/post?utm_source=b','2026-10-01','B正文','b');
    const before=db.db.prepare('SELECT * FROM entries ORDER BY id').all();db.db.exec('DROP TRIGGER feed_icon_keys_update; DROP TABLE feed_icon_keys; DROP TABLE ai_filter_decisions; DROP TABLE entry_identities; DROP INDEX entries_feed_id_identity; PRAGMA user_version=26');db.close();
    upgraded=await RivuDatabase.open(path);assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(upgraded.db.prepare('SELECT * FROM entries ORDER BY id').all(),before);assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.equal(upgraded.addEntries(feed.id,[{title:'旧A',guid:'old-a',url:'https://example.com/post?utm_source=c',hash:'new-a'}]),0);
    assert.throws(()=>upgraded.addEntries(feed.id,[{title:'不明确',guid:'another',url:'https://example.com/post',hash:'ambiguous'}]),/标识存在冲突/);assert.equal(upgraded.entries().length,2);
    const snapshots=readdirSync(dir).filter(name=>name.startsWith('pre-migration-'));assert.equal(snapshots.length,1);const copy=new DatabaseSync(join(dir,snapshots[0]),{readOnly:true});try{assert.equal(copy.prepare('PRAGMA user_version').get().user_version,26);assert.deepEqual(copy.prepare('SELECT * FROM entries ORDER BY id').all(),before);}finally{copy.close();}
  }finally{try{db.close();}catch{}upgraded?.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed identity backfill rolls back schema version and data while retaining the pre-migration snapshot',async ()=>{
  const {dir,path,db}=setup();try{
    const feed=db.addFeed({title:'失败回滚',url:'https://example.com/rollback'});db.addEntries(feed.id,[{title:'保留',content:'正文',hash:'keep'}]);const before=db.db.prepare('SELECT * FROM entries').all();
    db.db.exec("DELETE FROM entry_identities; CREATE TRIGGER fail_identity BEFORE INSERT ON entry_identities BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END; PRAGMA user_version=26");db.close();
    await assert.rejects(()=>RivuDatabase.open(path),/fixture migration failure/);const original=new DatabaseSync(path);try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,26);assert.deepEqual(original.prepare('SELECT * FROM entries').all(),before);assert.equal(original.prepare('SELECT count(*) n FROM entry_identities').get().n,0);}finally{original.close();}assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('canonical HTML metadata joins future feed URLs without extra requests or cross-origin declarations',async()=>{
  const {dir,db}=setup();let requests=0;
  const server=createServer((req,res)=>{requests++;if(req.url==='/page'){res.setHeader('content-type','text/html');res.end(`<html><head><title>文章</title><link rel="canonical" href="/canonical?lang=zh&utm_source=site"></head><body><article><p>${'可读正文。'.repeat(100)}</p></article></body></html>`);return;}const origin=`http://127.0.0.1:${server.address().port}`;res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>来源</title><item><guid>changed</guid><title>文章</title><link>${origin}/canonical?lang=zh</link><description>正文</description></item></channel></rss>`);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,feed=db.addFeed({title:'来源',url:origin+'/feed',allowPrivate:true});db.addEntries(feed.id,[{title:'文章',guid:'original',url:origin+'/page',content:'摘要',hash:sha('original')}]);const id=db.entries()[0].id,service=createService(db,'canonical-token');
  try{
    const response=await service.app.inject({method:'POST',url:`/api/entries/${id}/full-text`,headers:{'x-rivu-token':'canonical-token'}});assert.equal(response.statusCode,200,response.body);assert.equal(requests,1);
    assert.equal((await refreshFeed(db,feed.id)).added,0);assert.equal(db.entries()[0].id,id);assert.equal(requests,2);
    db.setFullContent(id,'<p>其他正文</p>','https://other.example/canonical');assert.equal(db.db.prepare("SELECT count(*) n FROM entry_identities WHERE kind='canonical' AND value LIKE '%other.example%'").get().n,0);
    assert.equal(db.addEntries(feed.id,[{title:'不同语言',guid:'another',url:origin+'/canonical?lang=en',hash:'lang-en'}]),1);
  }finally{await service.stop();db.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
