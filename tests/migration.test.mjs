import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportOpml, previewOpml } from '../dist-server/opml.js';
import { refreshFeed } from '../dist-server/feeds.js';
import { createService } from '../dist-server/service.js';
const require=createRequire(import.meta.url);
const {RivuDatabase}=require('../dist-server/database.cjs');

test('v0.1 database migrates with a snapshot and keeps feeds, search and reading state',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-upgrade-'));const path=join(dir,'rivu.db');
  const old=new DatabaseSync(path);
  try{old.exec(`
    CREATE TABLE categories (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,icon TEXT,sort INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE feeds (id TEXT PRIMARY KEY,title TEXT NOT NULL,url TEXT NOT NULL UNIQUE,site_url TEXT,description TEXT,icon TEXT,type TEXT NOT NULL DEFAULT 'rss',category_id TEXT REFERENCES categories(id),last_fetched_at TEXT,fetch_interval INTEGER NOT NULL DEFAULT 30,enabled INTEGER NOT NULL DEFAULT 1,failure_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,next_fetch_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE entries (id TEXT PRIMARY KEY,feed_id TEXT NOT NULL REFERENCES feeds(id),guid TEXT,title TEXT NOT NULL,author TEXT,url TEXT,published_at TEXT,fetched_at TEXT NOT NULL,content TEXT,description TEXT,cover TEXT,language TEXT,read INTEGER NOT NULL DEFAULT 0,starred INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,saved INTEGER NOT NULL DEFAULT 0,hash TEXT NOT NULL,UNIQUE(feed_id,hash));
    CREATE VIRTUAL TABLE entry_fts USING fts5(title,content,description,author,content='entries',content_rowid='rowid',tokenize='trigram');
    CREATE TRIGGER entry_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,new.content,new.description,new.author); END;
    CREATE TRIGGER entry_ad AFTER DELETE ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,old.content,old.description,old.author); END;
    CREATE TRIGGER entry_au AFTER UPDATE OF title,content,description,author ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,old.content,old.description,old.author); INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,new.content,new.description,new.author); END;
    INSERT INTO categories(id,name,created_at) VALUES ('old-category','原有分类','2026-01-01');
    INSERT INTO feeds(id,title,url,category_id,created_at) VALUES ('old-feed','原有订阅','https://example.com/feed','old-category','2026-01-01');
    INSERT INTO entries(id,feed_id,title,fetched_at,content,read,starred,hash) VALUES ('old-entry','old-feed','原有文章','2026-01-01','旧正文',1,1,'old-hash');
  `);}finally{old.close();}
  try{const stages=[];const upgraded=await RivuDatabase.open(path,stage=>stages.push(stage));assert.deepEqual(stages,['snapshot','schema','index','verify','done']);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.feeds().length,1);const article=upgraded.entry('old-entry');assert.equal(article.read,1);assert.equal(article.starred,1);assert.equal(upgraded.entries({query:'原有文章'}).length,1);assert.equal(upgraded.rsshubInstances().length,1);upgraded.setFullContent('old-entry','<p>迁移后的完整内容</p>');assert.equal(upgraded.entries({query:'完整内容'}).length,1);assert.equal(upgraded.tags().length,0);assert.equal(upgraded.deleteCategory('old-category'),1);assert.equal(upgraded.feed('old-feed').category_id,null);assert.equal(upgraded.deleteFeed('old-feed'),1);assert.equal(upgraded.entry('old-entry'),undefined);const official=upgraded.rsshubInstances()[0];upgraded.deleteRsshubInstance(official.id);}finally{upgraded.close();}const snapshots=readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db'));assert.equal(snapshots.length,1);const before=new DatabaseSync(join(dir,snapshots[0]),{readOnly:true});try{assert.equal(before.prepare('PRAGMA user_version').get().user_version,0);assert.equal(before.prepare('SELECT read,starred FROM entries WHERE id=?').get('old-entry').read,1);}finally{before.close();}const reopened=await RivuDatabase.open(path);try{assert.equal(reopened.rsshubInstances().length,0);}finally{reopened.close();}assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('legacy orphan articles recover under a disabled source without losing reading state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-orphan-recovery-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'曾有订阅',url:'https://example.com/lost-feed'});
    old.addEntries(feed.id,[{title:'保留的旧文章',content:'历史正文',hash:'orphan-one'}]);
    const entry=old.entries({feedId:feed.id})[0];old.updateEntry(entry.id,{read:true,starred:true,saved:true});
    old.db.exec('PRAGMA foreign_keys=OFF');old.db.prepare('DELETE FROM feeds WHERE id=?').run(feed.id);old.db.exec('PRAGMA user_version=23');old.close();
    const upgraded=await RivuDatabase.open(path);
    try{
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
      assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length,0);
      const recovered=upgraded.feed(feed.id);
      assert.equal(recovered.enabled,0);assert.match(recovered.title,/来源地址缺失/);assert.match(recovered.url,/^https:\/\/recovered\.invalid\//);
      assert.doesNotMatch(exportOpml(upgraded),/recovered\.invalid/);
      assert.throws(()=>upgraded.updateFeed(feed.id,{enabled:true}),/原订阅地址缺失/);
      assert.throws(()=>upgraded.updateFeed(feed.id,{enabled:1}),/订阅状态无效/);
      assert.throws(()=>upgraded.addFeed({title:'伪造恢复源',url:'https://recovered.invalid/feed/crafted'}),/保留给历史文章恢复/);
      assert.throws(()=>upgraded.addFeed({title:'伪造恢复源',url:'HTTPS://RECOVERED.INVALID./feed/crafted'}),/保留给历史文章恢复/);
      const preview=previewOpml(upgraded,'<?xml version="1.0"?><opml version="2.0"><body><outline text="伪造恢复源" xmlUrl="https://recovered.invalid/feed/crafted"/></body></opml>');
      assert.equal(preview.invalidCount,1);
      await assert.rejects(refreshFeed(upgraded,feed.id),/原订阅地址缺失/);
      const service=createService(upgraded,'recovery-token'),headers={'x-rivu-token':'recovery-token'};
      try{
        const numeric=await service.app.inject({method:'PATCH',url:`/api/feeds/${feed.id}`,headers,payload:{enabled:1}});assert.equal(numeric.statusCode,400);
        const bulk=await service.app.inject({method:'POST',url:'/api/feeds/bulk',headers,payload:{ids:[feed.id],action:'pause',enabled:true}});assert.equal(bulk.statusCode,400);
        assert.equal(upgraded.feed(feed.id).enabled,0);
      }finally{await service.stop();}
      const article=upgraded.entry(entry.id);
      assert.equal(article.content,'历史正文');assert.equal(article.read,1);assert.equal(article.starred,1);assert.equal(article.saved,1);
    }finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v25 AI rule migration preserves rules but requires fresh credential authorization',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-rule-v25-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧规则来源',url:'https://example.com/old-rule'});
    old.addEntries(feed.id,[{title:'旧文章',content:'本地正文',hash:'old-rule-entry'}]);
    old.db.prepare('INSERT INTO ai_rules(id,name,enabled,auto_run,conditions,action_type,max_items,provider,model,credential_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-ai-rule','旧自动规则',1,1,'{}','summary',10,'http://127.0.0.1:1234/v1','local-model','old-account','2026-09-01','2026-09-01');
    old.db.exec('ALTER TABLE ai_rules DROP COLUMN credential_id; PRAGMA user_version=25');old.close();
    const upgraded=await RivuDatabase.open(path),headers={'x-rivu-token':'migration-token'},service=createService(upgraded,'migration-token',join(dir,'settings.json'));
    try{
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
      assert.equal(upgraded.db.prepare('SELECT name,enabled,auto_run,credential_id FROM ai_rules WHERE id=?').get('legacy-ai-rule').credential_id,null);
      await service.app.inject({method:'PATCH',url:'/api/ai/settings',headers,payload:{model:'local-model'}});
      const listed=(await service.app.inject({method:'GET',url:'/api/ai-rules',headers})).json();assert.equal(listed[0].enabled,true);assert.equal(listed[0].needsAuthorization,true);
      assert.equal((await service.app.inject({method:'POST',url:'/api/ai-rules/legacy-ai-rule/run',headers,payload:{}})).statusCode,409);
    }finally{await service.stop();upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v24 recovery placeholder is disabled on upgrade and excluded from automatic refresh',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-recovered-v24-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);
    old.db.prepare('INSERT INTO feeds(id,title,url,type,enabled,created_at) VALUES (?,?,?,?,?,?)').run('old-recovered','旧占位源','HTTPS://RECOVERED.INVALID./feed/old','rss',1,'2026-01-01');
    old.db.exec('PRAGMA user_version=24');old.close();
    const upgraded=await RivuDatabase.open(path);
    try{
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
      assert.equal(upgraded.feed('old-recovered').enabled,0);
      upgraded.db.prepare('UPDATE feeds SET enabled=1 WHERE id=?').run('old-recovered');
      assert.equal(upgraded.dueFeeds().some(feed=>feed.id==='old-recovered'),false);
    }finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('unsupported future database fails closed without changing its version',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-future-'));const path=join(dir,'rivu.db');
  try{const future=new DatabaseSync(path);future.exec('PRAGMA user_version=99; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel(value) VALUES (\'keep\');');future.close();await assert.rejects(()=>RivuDatabase.open(path),/高于当前支持版本/);const unchanged=new DatabaseSync(path,{readOnly:true});try{assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version,99);assert.equal(unchanged.prepare('SELECT value FROM sentinel').get().value,'keep');}finally{unchanged.close();}}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('migration progress observer errors do not change a committed upgrade',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-stage-observer-')),path=join(dir,'rivu.db');
  try{
    const seeded=await RivuDatabase.open(path);seeded.addFeed({title:'保留订阅',url:'https://example.com/stage'});seeded.db.exec('PRAGMA user_version=18');seeded.close();
    const upgraded=await RivuDatabase.open(path,()=>{throw Error('observer failed');});
    try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.feeds()[0].title,'保留订阅');}finally{upgraded.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v3 database upgrades reading positions without losing article state',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v3-position-'));const path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'已有订阅',url:'https://example.com/v3'});old.addEntries(feed.id,[{title:'已有文章',content:'原正文',hash:'v3-one'}]);const id=old.entries()[0].id;old.updateEntry(id,{read:true,saved:true});old.db.exec('DROP TABLE reading_positions; PRAGMA user_version=3;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(id).read,1);assert.equal(upgraded.entry(id).saved,1);assert.equal(upgraded.readingPosition(id),undefined);upgraded.saveReadingPosition(id,0.6);assert.equal(upgraded.readingPosition(id).progress,0.6);}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v4 database adds offline save metadata and keeps reading position',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v4-offline-'));const path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'已有订阅',url:'https://example.com/v4'});old.addEntries(feed.id,[{title:'已有文章',content:'订阅正文',hash:'v4-one'}]);const id=old.entries()[0].id;old.updateEntry(id,{saved:true});old.saveReadingPosition(id,0.37);old.db.exec('DROP TABLE offline_saves; PRAGMA user_version=4;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(id).saved,1);assert.equal(upgraded.readingPosition(id).progress,0.37);assert.equal(upgraded.offlineSave(id),undefined);upgraded.setOfflineSave(id,true,'partial','图片下载失败');assert.equal(upgraded.offlineSave(id).status,'partial');}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v5 database defaults existing feeds and RSSHub instances to private-network denial',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v5-trust-'));const path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'原有本地订阅',url:'http://127.0.0.1:3000/feed',allowPrivate:true});old.addEntries(feed.id,[{title:'原有文章',content:'保留正文',hash:'v5-one'}]);const id=old.entries()[0].id;old.updateEntry(id,{saved:true});old.setOfflineSave(id,true,'partial','原有离线记录');const instance=old.addRsshubInstance('本地 RSSHub','http://127.0.0.1:1200',true);
    old.db.exec('DROP INDEX IF EXISTS feeds_metadata; ALTER TABLE feeds DROP COLUMN allow_private; ALTER TABLE rsshub_instances DROP COLUMN allow_private; PRAGMA user_version=5;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.feed(feed.id).allow_private,0);assert.equal(upgraded.rsshubInstance(instance.id).allow_private,0);assert.equal(upgraded.entry(id).saved,1);assert.equal(upgraded.entry(id).content,'保留正文');assert.equal(upgraded.offlineSave(id).last_error,'原有离线记录');}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v6 database adds timeline sort indexes and preserves saved articles',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v6-index-'));const path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'旧时间线',url:'https://example.com/v6'});old.addEntries(feed.id,[{title:'旧文章',hash:'v6-one'}]);const id=old.entries()[0].id;old.updateEntry(id,{saved:true});old.db.exec('DROP INDEX entries_sort_time; DROP INDEX entries_feed_sort_time; PRAGMA user_version=6;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(id).saved,1);assert.equal(upgraded.entries({feedId:feed.id})[0].id,id);for(const name of ['entries_sort_time','entries_feed_sort_time'])assert.ok(upgraded.db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('index',name));}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v7 database adds local rules without changing manual article state',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v7-rules-'));const path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'原有订阅',url:'https://example.com/v7'});old.addEntries(feed.id,[{title:'手动收藏文章',hash:'v7-one'}]);const id=old.entries()[0].id;old.updateEntry(id,{saved:true});old.db.exec('DROP TABLE rule_matches; DROP TABLE rules; PRAGMA user_version=7;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(id).saved,1);assert.equal(upgraded.entry(id).rule_saved,0);assert.equal(upgraded.db.prepare('SELECT count(*) n FROM rules').get().n,0);}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v8 database adds saved queries without copying or changing articles',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v8-smart-'));const path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'已有订阅',url:'https://example.com/v8'});old.addEntries(feed.id,[{title:'已有文章',hash:'v8-one'}]);const id=old.entries()[0].id;old.updateEntry(id,{saved:true});old.db.exec('DROP TABLE smart_folders; PRAGMA user_version=8;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(id).saved,1);assert.equal(upgraded.db.prepare('SELECT count(*) n FROM smart_folders').get().n,0);assert.equal(upgraded.db.prepare('SELECT count(*) n FROM entries').get().n,1);}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v9 database adds local chat history and cache fingerprints without losing AI results',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v9-chat-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧订阅',url:'https://example.com/v9'});old.addEntries(feed.id,[{title:'旧文章',content:'旧正文',hash:'v9-one'}]);const id=old.entries()[0].id;old.saveAI(id,'summary','zh-CN','local','model','旧摘要');old.db.exec('DROP TABLE ai_messages; DROP TABLE ai_conversations; ALTER TABLE ai_results DROP COLUMN content_hash; PRAGMA user_version=9;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.aiResult(id,'summary','zh-CN').content,'旧摘要');assert.equal(upgraded.aiResult(id,'summary','zh-CN').content_hash,'');assert.equal(upgraded.db.prepare('SELECT count(*) n FROM ai_conversations').get().n,0);}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v10 database adds opt-in AI rule jobs without changing articles or local chats',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v10-ai-rules-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'原订阅',url:'https://example.com/v10'});old.addEntries(feed.id,[{title:'原文章',content:'保留正文',hash:'v10-one'}]);const entry=old.entries()[0];old.db.prepare('INSERT INTO ai_conversations(id,title,entry_ids,created_at,updated_at) VALUES (?,?,?,?,?)').run('old-chat','原对话',JSON.stringify([entry.id]),new Date().toISOString(),new Date().toISOString());old.db.exec('DROP TABLE ai_rule_jobs; DROP TABLE ai_rules; PRAGMA user_version=10;');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(entry.id).content,'保留正文');assert.equal(upgraded.db.prepare('SELECT title FROM ai_conversations WHERE id=?').get('old-chat').title,'原对话');assert.equal(upgraded.db.prepare('SELECT count(*) n FROM ai_rules').get().n,0);}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')&&name.endsWith('.db')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v11 AI rule layout gains persistent error reporting without losing jobs',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v11-ai-rule-')),path=join(dir,'rivu.db');
  try{
    const seeded=await RivuDatabase.open(path),feed=seeded.addFeed({title:'旧 AI 源',url:'https://example.com/old-ai'});seeded.addEntries(feed.id,[{title:'旧文章',content:'旧正文',hash:'old-ai'}]);const entry=seeded.entries()[0],now=new Date().toISOString();
    seeded.db.prepare('INSERT INTO ai_rules(id,name,conditions,action_type,max_items,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('old-rule','旧规则','{}','summary',2,now,now);
    seeded.db.prepare("INSERT INTO ai_rule_jobs(rule_id,entry_id,source_hash,provider,model,status,created_at,updated_at) VALUES (?,?,?,?,?,'failed',?,?)").run('old-rule',entry.id,'old-hash','http://127.0.0.1:1234/v1','old-model',now,now);
    seeded.close();const legacy=new DatabaseSync(path);legacy.exec('DROP TABLE entry_media; ALTER TABLE ai_rules DROP COLUMN last_error; PRAGMA user_version=11;');legacy.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.db.prepare('SELECT name,last_error FROM ai_rules WHERE id=?').get('old-rule').name,'旧规则');assert.equal(upgraded.db.prepare('SELECT status FROM ai_rule_jobs WHERE rule_id=?').get('old-rule').status,'failed');assert.equal(upgraded.entry(entry.id).content,'旧正文');}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v12 database adds entry media without changing saved articles or rule tasks',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v12-media-')),path=join(dir,'rivu.db');
  try{
    const seeded=await RivuDatabase.open(path),feed=seeded.addFeed({title:'媒体迁移源',url:'https://example.com/media'});seeded.addEntries(feed.id,[{title:'已保存文章',url:'https://example.com/article',content:'原始正文<img src="/old-image.png">',hash:'media-old'}]);const entry=seeded.entries()[0];seeded.updateEntry(entry.id,{saved:true});seeded.db.prepare('INSERT INTO ai_rules(id,name,conditions,action_type,max_items,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('media-rule','媒体迁移规则','{}','summary',2,new Date().toISOString(),new Date().toISOString());seeded.close();
    const legacy=new DatabaseSync(path);legacy.exec('DROP TABLE entry_media; PRAGMA user_version=12;');legacy.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(entry.id).saved,1);assert.equal(upgraded.db.prepare('SELECT name FROM ai_rules WHERE id=?').get('media-rule').name,'媒体迁移规则');assert.equal(upgraded.entryMedia(entry.id)[0].url,'https://example.com/old-image.png');}finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an invalid legacy schema rolls back every schema change and keeps a pre-migration snapshot',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-rollback-'));const path=join(dir,'rivu.db');
  try{const old=new DatabaseSync(path);old.exec("CREATE TABLE feeds(id TEXT PRIMARY KEY,title TEXT,url TEXT); INSERT INTO feeds(id,title,url) VALUES ('keep','原订阅','https://example.com/feed');");old.close();await assert.rejects(()=>RivuDatabase.open(path),/数据库结构不完整/);const preserved=new DatabaseSync(path,{readOnly:true});try{assert.equal(preserved.prepare('PRAGMA user_version').get().user_version,0);assert.equal(preserved.prepare("SELECT title FROM feeds WHERE id='keep'").get().title,'原订阅');assert.equal(preserved.prepare("SELECT name FROM sqlite_master WHERE name='entries'").get(),undefined);assert.equal(preserved.prepare('PRAGMA table_info(feeds)').all().some(row=>row.name==='rsshub_instance_id'),false);}finally{preserved.close();}assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('an unversioned current-layout fixture preserves tags, full text, AI cache and saved state',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-unversioned-'));const path=join(dir,'rivu.db');
  try{const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'旧版订阅',url:'https://example.com/feed'});old.addEntries(feed.id,[{title:'旧版文章',hash:'v02'}]);const entry=old.entries()[0];old.updateEntry(entry.id,{read:true,starred:true,saved:true});old.setFullContent(entry.id,'<p>本地全文</p>');const tag=old.addTag('旧标签');old.setEntryTags(entry.id,[tag.id]);old.saveAI(entry.id,'summary','zh-CN','local','model','旧摘要');old.db.exec('PRAGMA user_version=0');old.close();const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(entry.id).read,1);assert.equal(upgraded.entry(entry.id).starred,1);assert.equal(upgraded.entry(entry.id).saved,1);assert.match(upgraded.entry(entry.id).full_content,/本地全文/);assert.equal(upgraded.entryTags(entry.id)[0].name,'旧标签');assert.equal(upgraded.aiResult(entry.id,'summary','zh-CN').content,'旧摘要');}finally{upgraded.close();}assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);}
  finally{rmSync(dir,{recursive:true,force:true});}
});

test('v16 database adds unread count index without changing article state',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v16-unread-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'索引迁移源',url:'https://example.com/unread'});
    old.addEntries(feed.id,[{title:'未读',hash:'unread'},{title:'已读',hash:'read'}]);
    old.updateEntry(old.entries().find(row=>row.title==='已读').id,{read:true});
    old.db.exec('DROP INDEX entries_feed_unread; PRAGMA user_version=16');old.close();
    const stages=[];
    const upgraded=await RivuDatabase.open(path,stage=>stages.push(stage));
    try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='entries_feed_unread'").get());assert.equal(upgraded.feeds().find(row=>row.id===feed.id).unread_count,1);const unread=upgraded.entries({feedId:feed.id,view:'unread'})[0];upgraded.db.prepare('INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('mute-test','静音测试','{}','mute','2026-09-26','2026-09-26');upgraded.db.prepare('INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES (?,?,?)').run('mute-test',unread.id,'2026-09-26');assert.equal(upgraded.feeds().find(row=>row.id===feed.id).unread_count,0);upgraded.db.prepare('UPDATE rules SET enabled=0 WHERE id=?').run('mute-test');assert.equal(upgraded.feeds().find(row=>row.id===feed.id).unread_count,1);}
    finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('v19 feed health migrates known successful refresh times without inventing unknown history',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-feed-health-v20-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path);
    const successful=old.addFeed({title:'成功源',url:'https://example.com/success'}),failed=old.addFeed({title:'失败源',url:'https://example.com/failed'}),never=old.addFeed({title:'未刷新源',url:'https://example.com/never'});
    old.markFetch(successful.id);
    old.markFetch(failed.id);old.markFetch(failed.id,'HTTP 503');
    const known=old.feed(successful.id).last_fetched_at;
    old.db.exec('DROP INDEX IF EXISTS feeds_metadata; ALTER TABLE feeds DROP COLUMN last_success_at; PRAGMA user_version=19');old.close();
    const stages=[];
    const upgraded=await RivuDatabase.open(path,stage=>stages.push(stage));
    try{
      assert.deepEqual(stages,['snapshot','schema','verify','done']);
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
      assert.equal(upgraded.feed(successful.id).last_success_at,known);
      assert.equal(upgraded.feed(failed.id).last_success_at,null);
      assert.equal(upgraded.feed(never.id).last_success_at,null);
      upgraded.markFetch(failed.id);
      const recovered=upgraded.feed(failed.id).last_success_at;
      assert.equal(recovered,upgraded.feed(failed.id).last_fetched_at);
      upgraded.markFetch(failed.id,'HTTP 500');
      assert.equal(upgraded.feed(failed.id).last_success_at,recovered);
      assert.equal(upgraded.feed(failed.id).failure_count,1);
      upgraded.markFetch(failed.id,'');
      assert.equal(upgraded.feed(failed.id).last_success_at,recovered);
      assert.equal(upgraded.feed(failed.id).failure_count,2);
      assert.equal(upgraded.feed(failed.id).last_error,'未知错误');
    }finally{upgraded.close();}
    const snapshot=readdirSync(dir).find(name=>name.startsWith('pre-migration-')&&name.endsWith('.db'));
    assert.ok(snapshot);
    const before=new DatabaseSync(join(dir,snapshot),{readOnly:true});
    try{assert.equal(before.prepare('PRAGMA user_version').get().user_version,19);assert.equal(before.prepare('PRAGMA table_info(feeds)').all().some(column=>column.name==='last_success_at'),false);}finally{before.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
