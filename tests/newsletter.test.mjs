import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RivuDatabase } from '../dist-server/database.cjs';
import { refreshFeed } from '../dist-server/feeds.js';
import { previewNewsletterFolder, parseNewsletterMessage } from '../dist-server/newsletter.js';
import { exportOpml } from '../dist-server/opml.js';
import { createBackup, inspectBackup, restoreBackup } from '../dist-server/backup.js';

test('bounded RFC2047 word runs decode correctly without quadratic header joining', {timeout:5000},async()=>{
  const raw=Buffer.from('From: local@example.com\r\nSubject: '+ '=?utf-8?B?QUJD?= '.repeat(5000)+'\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLocal body');
  assert.ok(raw.byteLength<128000);
  const parsed=await parseNewsletterMessage(raw);
  assert.equal(parsed.title,'ABC'.repeat(5000).slice(0,1000));
  assert.match(parsed.content,/Local body/);
});

const first=`From: =?UTF-8?B?5rWL6K+V5Y+R5Lu25Lq6?= <news@example.com>\r\nSubject: =?UTF-8?B?5pys5Zyw6YKu5Lu25rWL6K+V?=\r\nMessage-ID: <issue-1@example.com>\r\nDate: Mon, 28 Sep 2026 10:00:00 +0800\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="issue"\r\n\r\n--issue\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><body><h1>本地周报</h1><p>可离线阅读 <a href="https://example.com/story">原文</a></p><img src="https://tracker.example/pixel"><script>alert(1)</script><form action="https://evil.example"></form><div style="background:url(https://tracker.example/x)">正文</div></body></html>\r\n--issue\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="secret.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nUERG\r\n--issue--\r\n`;

test('Newsletter folder imports EML locally, skips trackers and duplicates, requires reauthorization after restore',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-newsletter-')),restored=mkdtempSync(join(tmpdir(),'rivu-newsletter-restore-')),folder=join(dir,'mail');mkdirSync(folder);
  const path=join(dir,'rivu.db'),url=pathToFileURL(folder).href;
  writeFileSync(join(folder,'issue-1.eml'),first);writeFileSync(join(folder,'ignore.txt'),'not mail');
  const db=await RivuDatabase.open(path);
  try{
    const preview=await previewNewsletterFolder(folder);assert.equal(preview.count,1);assert.equal(preview.samples.length,1);assert.equal(preview.samples[0].sender,'news@example.com');
    const feed=db.addFeed({title:'我的 Newsletter',url,type:'newsletter',folderAuthorized:true});
    assert.equal((await refreshFeed(db,feed.id)).added,1);
    const entry=db.entries({feedId:feed.id})[0];assert.match(entry.content,/本地周报/);assert.match(entry.content,/https:\/\/example.com\/story/);assert.doesNotMatch(entry.content,/tracker\.example|<img|<script|<form|style=/i);assert.equal(entry.url,null);
    assert.equal((await refreshFeed(db,feed.id)).added,0);
    writeFileSync(join(folder,'issue-2.eml'),'From: news@example.com\nSubject: 第二期\nMessage-ID: <issue-2@example.com>\nContent-Type: text/plain; charset=utf-8\n\n第二期正文');
    assert.equal((await refreshFeed(db,feed.id)).added,1);assert.equal(db.entries({feedId:feed.id}).length,2);
    assert.doesNotMatch(exportOpml(db),/rivu-newsletter|file:\/\/|我的 Newsletter/);
    const zip=join(dir,'newsletter.zip');await createBackup(db,dir,zip);assert.equal((await inspectBackup(zip)).schemaVersion,SCHEMA_VERSION);
    await restoreBackup(zip,restored);
    const recovered=await RivuDatabase.open(join(restored,'rivu.db'));
    try{
      assert.equal(recovered.feed(feed.id).folder_authorized,0);assert.equal(recovered.entries({feedId:feed.id}).length,2);
      await assert.rejects(refreshFeed(recovered,feed.id),/重新选择 Newsletter 文件夹/);
      recovered.reconnectNewsletter(feed.id,url);
      assert.equal((await refreshFeed(recovered,feed.id)).added,0);
      writeFileSync(join(folder,'issue-3.eml'),'From: news@example.com\nSubject: 第三期\nMessage-ID: <issue-3@example.com>\n\n新一期正文');
      assert.equal((await refreshFeed(recovered,feed.id)).added,1);
    }finally{recovered.close();}
  }finally{db.close();rmSync(dir,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});

test('v21 database adds Newsletter permission and scan cache with a protective snapshot',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-newsletter-v21-')),path=join(dir,'rivu.db');
  try{const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'原有订阅',url:'https://example.com/feed'});old.db.exec('DROP TABLE newsletter_files; DROP INDEX IF EXISTS feeds_metadata; ALTER TABLE feeds DROP COLUMN folder_authorized; PRAGMA user_version=21');old.close();const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.feed(feed.id).folder_authorized,0);assert.equal(upgraded.db.prepare('SELECT count(*) n FROM newsletter_files').get().n,0);}finally{upgraded.close();}assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('bad EML files do not block later mail or trigger refresh backoff',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-newsletter-bad-')),folder=join(dir,'mail');mkdirSync(folder);
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    for(let i=0;i<500;i++)writeFileSync(join(folder,`a-${String(i).padStart(3,'0')}.eml`),'');
    writeFileSync(join(folder,'z-valid.eml'),'From: news@example.com\nSubject: 可用邮件\nMessage-ID: <after-bad@example.com>\n\n正文');
    const feed=db.addFeed({title:'坏邮件测试',url:pathToFileURL(folder).href,type:'newsletter',folderAuthorized:true});
    assert.equal((await refreshFeed(db,feed.id)).added,0);
    assert.equal(db.feed(feed.id).failure_count,0);
    assert.ok(db.feed(feed.id).last_success_at);
    assert.match(db.feed(feed.id).last_error,/500 个/);
    assert.equal((await refreshFeed(db,feed.id)).added,1);
    assert.equal(db.entries({feedId:feed.id}).length,1);
    assert.equal(db.feed(feed.id).failure_count,0);
    assert.match(db.feed(feed.id).last_error,/500 个/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('unchanged metadata is audited in bounded rotations so overwritten mail is eventually imported',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-newsletter-audit-')),folder=join(dir,'mail');mkdirSync(folder);
  const db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    for(let i=0;i<50;i++)writeFileSync(join(folder,`a-${String(i).padStart(2,'0')}.eml`),`Subject: Mail ${i}\nMessage-ID: <old-${i}@example.com>\n\nBody`);
    const target=join(folder,'z-last.eml');
    writeFileSync(target,'Subject: Latest\nMessage-ID: <mail-a@example.com>\n\nBody');
    const fixedTime=new Date('2026-09-28T10:00:00.000Z');
    utimesSync(target,fixedTime,fixedTime);
    const feed=db.addFeed({title:'轮转审计',url:pathToFileURL(folder).href,type:'newsletter',folderAuthorized:true});
    assert.equal((await refreshFeed(db,feed.id)).added,51);
    const original=statSync(target);
    writeFileSync(target,'Subject: Latest\nMessage-ID: <mail-b@example.com>\n\nBody');
    utimesSync(target,original.atime,original.mtime);
    const replaced=statSync(target);
    assert.equal(replaced.size,original.size);
    assert.equal(Math.trunc(replaced.mtimeMs),Math.trunc(original.mtimeMs));
    assert.equal((await refreshFeed(db,feed.id)).added,0,'首次只审计前 50 个未变化文件');
    assert.equal((await refreshFeed(db,feed.id)).added,1,'下轮应审计被覆盖的第 51 个文件');
    assert.equal(db.entries({feedId:feed.id}).length,52);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('first Newsletter v22 database upgrades cached files to v23 without losing mail',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-newsletter-v22-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧 Newsletter',url:pathToFileURL(dir).href,type:'newsletter',folderAuthorized:true});
    old.addEntries(feed.id,[{title:'已导入邮件',guid:'old-mail',hash:'old-mail'}]);
    old.db.prepare('INSERT INTO newsletter_files(feed_id,file_name,modified_ms,size,failed) VALUES (?,?,?,?,0)').run(feed.id,'old.eml',123,456);
    old.db.exec('ALTER TABLE newsletter_files DROP COLUMN failed; PRAGMA user_version=22');old.close();
    const upgraded=await RivuDatabase.open(path);
    try{
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
      assert.equal(upgraded.entries({feedId:feed.id}).length,1);
      assert.equal(upgraded.db.prepare('SELECT failed FROM newsletter_files WHERE feed_id=?').get(feed.id).failed,0);
      assert.equal(upgraded.feed(feed.id).folder_authorized,1);
    }finally{upgraded.close();}
    assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
