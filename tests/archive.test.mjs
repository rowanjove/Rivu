import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { createService } from '../dist-server/service.js';
import { createBackup, inspectBackup, restoreBackup } from '../dist-server/backup.js';
import { archiveStats, archiveVersion, exportArchive, getArchive, saveArchive } from '../dist-server/archive.js';
const require=createRequire(import.meta.url);
const {RivuDatabase}=require('../dist-server/database.cjs');

test('permanent archive survives feed deletion, retains only changed versions and exports readable HTML',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-archive-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  const feed=db.addFeed({title:'来源',url:'https://example.com/feed'});
  db.addEntries(feed.id,[{title:'归档文章',url:'https://example.com/article',content:'<p>第一版正文</p>',hash:'archive-one'}]);
  const id=db.entries()[0].id,service=createService(db,'archive-token',join(dir,'settings.json'),dir),headers={'x-rivu-token':'archive-token'};
  try{
    const first=await saveArchive(db,id);assert.equal(first.newVersion,true);
    const same=await saveArchive(db,id);assert.equal(same.newVersion,false);assert.equal(same.versions.length,1);
    db.setFullContent(id,'<p>第二版正文</p>');
    const next=await saveArchive(db,id);assert.equal(next.versions.length,2);
    const impact=await service.app.inject({method:'GET',url:`/api/feeds/${feed.id}/delete-preview`,headers});assert.deepEqual(impact.json(),{feedId:feed.id,title:'来源',entriesToDelete:1,archivesPreserved:1});
    const articleZip=join(dir,'article.zip');await exportArchive(db,next.id,articleZip);const exported=new AdmZip(articleZip);assert.match(exported.getEntry('index.html').getData().toString(),/第二版正文/);assert.match(exported.getEntry('versions/001.html').getData().toString(),/第一版正文/);
    const backupPath=join(dir,'archive-backup.zip');await createBackup(db,dir,backupPath);assert.equal((await inspectBackup(backupPath)).schemaVersion,SCHEMA_VERSION);
    const restoredDir=join(dir,'restored');await restoreBackup(backupPath,restoredDir);const restored=await RivuDatabase.open(join(restoredDir,'rivu.db'));try{assert.match(getArchive(restored,next.id).body_html,/第二版正文/);assert.equal(getArchive(restored,next.id).versions.length,2);const report=JSON.parse(readFileSync(join(restoredDir,'restore-report.json'),'utf8'));assert.ok(report.durationMs>=0&&report.backupBytes>0);}finally{restored.close();}
    db.deleteFeed(feed.id);assert.equal(db.entry(id),undefined);assert.match(getArchive(db,next.id).body_html,/第二版正文/);assert.equal(archiveStats(db).count,1);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('v13 database migrates to independent archive tables without changing entries',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-archive-upgrade-')),path=join(dir,'rivu.db');
  try{const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'旧订阅',url:'https://example.com/old'});old.addEntries(feed.id,[{title:'旧文章',content:'正文',hash:'old'}]);const id=old.entries()[0].id;old.db.exec('DROP TABLE archive_assets; DROP TABLE archive_versions; DROP TABLE permanent_archives; PRAGMA user_version=13');old.close();const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.entry(id).title,'旧文章');assert.equal(archiveStats(upgraded).count,0);}finally{upgraded.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('archive refuses empty body and binds refreshed same-URL assets to the changed version',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-archive-assets-')),fixture=createServer((req,res)=>{if(req.url==='/image.png'){res.setHeader('content-type','image/png');res.end(Buffer.from([imageState]));return;}res.setHeader('content-type','text/html');res.end('<script>alert(1)</script><p>来源快照</p>');});
  let imageState=1;await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${fixture.address().port}`,db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'本地测试源',url:`${base}/feed`,allowPrivate:true});db.addEntries(feed.id,[{title:'仅标题',hash:'empty'},{title:'有正文',url:`${base}/article`,content:`<p>第一版</p><img src="${base}/image.png">`,hash:'body'}]);
    const empty=db.entries().find(row=>row.title==='仅标题').id,id=db.entries().find(row=>row.title==='有正文').id;
    await assert.rejects(saveArchive(db,empty),/尚无可归档正文/);
    db.setFullContent(id,`<p>第一版</p><img src="${base}/image.png">`);
    const first=await saveArchive(db,id,{images:true,snapshot:true});assert.equal(first.assets.length,2);assert.equal(first.errors.length,0);
    imageState=2;db.setFullContent(id,`<p>第二版</p><img src="${base}/image.png">`);
    const next=await saveArchive(db,id,{images:true,snapshot:true});assert.equal(next.assets.length,2);assert.equal(next.errors.length,0);
    const old=archiveVersion(db,next.id,first.version_id),newer=archiveVersion(db,next.id,next.version_id);assert.notEqual(old.assets.find(a=>a.kind==='image').id,newer.assets.find(a=>a.kind==='image').id);
    const articleZip=join(dir,'media-article.zip');await exportArchive(db,next.id,articleZip);const zip=new AdmZip(articleZip);const firstPage=zip.getEntry('versions/001.html').getData().toString(),secondPage=zip.getEntry('versions/002.html').getData().toString();assert.match(firstPage,/\.\.\/assets\//);assert.match(secondPage,/\.\.\/assets\//);assert.doesNotMatch(zip.getEntries().find(e=>e.entryName.endsWith('.html')&&e.entryName.startsWith('assets/')).getData().toString(),/<script>/);
  }finally{db.close();fixture.close();rmSync(dir,{recursive:true,force:true});}
});

test('v14 archive assets migrate to version-scoped records without losing bytes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-archive-v14-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧源',url:'https://example.com/feed'});old.addEntries(feed.id,[{title:'旧文章',content:'正文',hash:'v14'}]);const id=old.entries()[0].id;const record=await saveArchive(old,id);const bytes=Buffer.from([1,2,3]);
    old.db.exec('DROP TABLE archive_assets; CREATE TABLE archive_assets (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, kind TEXT NOT NULL, url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(archive_id,url)); CREATE INDEX archive_assets_archive ON archive_assets(archive_id);');
    old.db.prepare('INSERT INTO archive_assets(id,archive_id,kind,url,mime,bytes,data) VALUES (?,?,?,?,?,?,?)').run('old-asset',record.id,'image','https://example.com/a.png','image/png',bytes.length,bytes);old.db.exec('PRAGMA user_version=14');old.close();
    const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(getArchive(upgraded,record.id).assets[0].id,'old-asset');assert.equal(Buffer.from(upgraded.db.prepare('SELECT data FROM archive_assets WHERE id=?').get('old-asset').data).toString('hex'),bytes.toString('hex'));}finally{upgraded.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('large archive assets stream through independent export and database backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-large-archive-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'大归档源',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'大归档文章',content:'大正文',hash:'large'}]);
    const record=await saveArchive(db,db.entries()[0].id),insert=db.db.prepare('INSERT INTO archive_assets(id,archive_id,version_id,kind,url,mime,bytes,data) VALUES (?,?,?,?,?,?,?,?)');
    const expected=[];
    for(let index=0;index<2;index++){const bytes=randomBytes(12*1024*1024),id=randomUUID();insert.run(id,record.id,record.version_id,'audio',`https://example.com/${index}.mp3`,'audio/mpeg',bytes.length,bytes);expected.push({id,digest:createHash('sha256').update(bytes).digest('hex')});}
    const exportedPath=join(dir,'large-article.zip');await exportArchive(db,record.id,exportedPath);const exported=new AdmZip(exportedPath);for(const item of expected){const entry=exported.getEntries().find(row=>row.entryName.includes(item.id));assert.ok(entry);assert.equal(createHash('sha256').update(entry.getData()).digest('hex'),item.digest);}
    const backupPath=join(dir,'large-backup.zip');await createBackup(db,dir,backupPath);assert.equal((await inspectBackup(backupPath)).schemaVersion,SCHEMA_VERSION);
    const restoredDir=join(dir,'restored');await restoreBackup(backupPath,restoredDir);const restored=await RivuDatabase.open(join(restoredDir,'rivu.db'));try{assert.equal(getArchive(restored,record.id).assets.length,2);}finally{restored.close();}
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('backup inspection rejects unexpected archive paths before extraction',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-zip-path-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{const valid=join(dir,'valid.zip');await createBackup(db,dir,valid);const altered=new AdmZip(valid);altered.addFile('../escaped.txt',Buffer.from('escape'));const attack=join(dir,'attack.zip');altered.writeZip(attack);await assert.rejects(inspectBackup(attack),/invalid|无效|路径|relative/i);assert.equal(existsSync(join(dir,'escaped.txt')),false);}finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('restore revalidates the exact ZIP selected after an earlier inspection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-restore-changed-')),sourceDb=await RivuDatabase.open(join(dir,'source.db'));
  try{
    const zipPath=join(dir,'selected.zip'),targetDir=join(dir,'target');
    await createBackup(sourceDb,dir,zipPath);await inspectBackup(zipPath);
    mkdirSync(targetDir);const target=await RivuDatabase.open(join(targetDir,'rivu.db'));target.addFeed({title:'保留的本地数据',url:'https://example.com/local'});target.close();
    const changed=new AdmZip(zipPath);changed.updateFile('rivu.db',Buffer.from('no longer a SQLite database'));changed.writeZip(zipPath);
    await assert.rejects(restoreBackup(zipPath,targetDir));
    const reopened=await RivuDatabase.open(join(targetDir,'rivu.db'));try{assert.equal(reopened.feeds()[0].title,'保留的本地数据');}finally{reopened.close();}
  }finally{sourceDb.close();rmSync(dir,{recursive:true,force:true});}
});
