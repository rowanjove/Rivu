import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import AdmZip from 'adm-zip';
import {JSDOM} from 'jsdom';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
import {exportArchive,getArchive,archiveStats} from '../dist-server/archive.js';
import {createBackup,restoreBackup} from '../dist-server/backup.js';

test('one URL retains all four resource roles through Worker save, repeat, export, feed deletion and backup restore',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-archive-roles-')),calls=[];
  const bodies={image:Buffer.from([0,1,255]),audio:Buffer.from('audio bytes'),video:Buffer.from('video bytes'),snapshot:Buffer.from('<script>alert(1)</script><p>snapshot</p><img src="/same"><video poster="/same" src="/same"></video>')};
  const server=createServer((req,res)=>{const accept=req.headers.accept||'',kind=accept.startsWith('image/')?'image':accept.startsWith('audio/')?'audio':accept.startsWith('video/')?'video':'snapshot';calls.push(kind);res.setHeader('content-type',{image:'image/png',audio:'audio/ogg',video:'video/mp4',snapshot:'text/html'}[kind]);res.end(bodies[kind]);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/same`,db=await RivuDatabase.open(join(dir,'rivu.db')),feed=db.addFeed({title:'Local',url:url+'/feed',allowPrivate:true});
  db.addEntries(feed.id,[{title:'Shared URL',url,hash:'roles',content:`<p>Body</p><img src="${url}"><audio src="${url}"></audio><video src="${url}" poster="${url}"><source src="${url}" type="video/mp4"></video>`,media:['image','audio','video'].map(kind=>({kind,url,mime:null,source:'enclosure',title:null}))}]);
  const id=db.entries()[0].id,service=createService(db,'token'),headers={'x-rivu-token':'token'};
  try{
    const save=()=>service.app.inject({method:'POST',url:`/api/entries/${id}/archive`,headers,payload:{images:true,attachments:true,snapshot:true}});
    const first=await save();assert.equal(first.statusCode,201,first.body);const record=first.json();assert.equal(record.errors.length,0);assert.equal(record.assetsAdded,4);assert.deepEqual([...calls].sort(),['audio','image','snapshot','video']);assert.deepEqual(record.assets.map(asset=>asset.kind).sort(),['audio','image','snapshot','video']);
    const repeated=await save();assert.equal(repeated.statusCode,201,repeated.body);assert.equal(repeated.json().assetsAdded,0);assert.equal(calls.length,4);
    for(const asset of record.assets){const response=await service.app.inject({method:'GET',url:`/api/archives/${record.id}/assets/${asset.id}`,headers});assert.equal(response.statusCode,200);assert.deepEqual(Buffer.from(response.json().dataUrl.split(',')[1],'base64'),bodies[asset.kind]);}
    assert.equal(archiveStats(db).bytes,Buffer.byteLength(record.body_html)+Object.values(bodies).reduce((n,bytes)=>n+bytes.length,0));
    const path=join(dir,'article.zip');await exportArchive(db,record.id,path);const zip=new AdmZip(path),manifest=JSON.parse(zip.readAsText('metadata.json')),assets=manifest.versions[0].assets;
    for(const page of ['index.html','versions/001.html']){const dom=new JSDOM(zip.readAsText(page));try{for(const [selector,attribute,kind] of [['img','src','image'],['audio','src','audio'],['video','src','video'],['video','poster','image'],['source','src','video']]){const expected=assets.find(asset=>asset.kind===kind).path;assert.equal(dom.window.document.querySelector(selector).getAttribute(attribute),(page.startsWith('versions/')?'../':'')+expected);}}finally{dom.window.close();}}
    for(const asset of assets){if(asset.kind==='snapshot'){const html=zip.readAsText(asset.path);assert.match(html,/snapshot/);assert.doesNotMatch(html,/<script|src=|poster=/);}else assert.deepEqual(zip.readFile(asset.path),bodies[asset.kind]);}
    assert.equal(new Set(assets.map(asset=>asset.path)).size,4);
    db.deleteFeed(feed.id);assert.equal(getArchive(db,record.id).assets.length,4);
    const backup=join(dir,'backup.zip');await createBackup(db,dir,backup);const restoredDir=join(dir,'restored');await restoreBackup(backup,restoredDir);const restored=await RivuDatabase.open(join(restoredDir,'rivu.db'));try{assert.equal(getArchive(restored,record.id).assets.length,4);for(const asset of restored.db.prepare('SELECT kind,data FROM archive_assets').all())assert.deepEqual(Buffer.from(asset.data),bodies[asset.kind]);}finally{restored.close();}
  }finally{await service.stop();db.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

function legacy(){const dir=mkdtempSync(join(tmpdir(),'rivu-archive-role-migration-')),path=join(dir,'rivu.db'),db=new RivuDatabase(path);
  db.db.exec("INSERT INTO permanent_archives VALUES ('a','entry','feed','feed','title',NULL,'date','date'); INSERT INTO archive_versions VALUES ('v','a','hash','body','date');");
  db.db.exec(`CREATE TABLE old_assets (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,url)); DROP TABLE archive_assets; ALTER TABLE old_assets RENAME TO archive_assets; CREATE INDEX archive_assets_archive ON archive_assets(archive_id,version_id);`);
  db.db.prepare('INSERT INTO archive_assets VALUES (?,?,?,?,?,?,?,?)').run('asset','a','v','image','https://example.invalid/same','image/png',3,Buffer.from([0,1,255]));
  for(const event of ['insert','update','delete'])db.db.exec(`CREATE TRIGGER archive_revision_archive_assets_${event} AFTER ${event.toUpperCase()} ON archive_assets BEGIN UPDATE app_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='archive_revision'; END;`);
  db.db.exec('PRAGMA user_version=31');db.close();return {dir,path};
}
test('schema31 role migration preserves IDs and bytes, permits distinct roles, maintains revision and snapshots',async ()=>{
  const f=legacy();try{const db=await RivuDatabase.open(f.path);try{assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(Buffer.from(db.db.prepare("SELECT data FROM archive_assets WHERE id='asset'").get().data),Buffer.from([0,1,255]));const before=db.db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get().value;db.db.exec("INSERT INTO archive_assets VALUES ('snapshot','a','v','snapshot','https://example.invalid/same','text/html',1,x'01')");assert.notEqual(db.db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get().value,before);assert.throws(()=>db.db.exec("INSERT INTO archive_assets VALUES ('duplicate','a','v','snapshot','https://example.invalid/same','text/html',1,x'01')"),/UNIQUE/);db.db.exec("DELETE FROM permanent_archives WHERE id='a'");assert.equal(db.db.prepare('SELECT count(*) n FROM archive_assets').get().n,0);}finally{db.close();}const files=readdirSync(f.dir).filter(name=>name.startsWith('pre-migration-'));assert.equal(files.length,1);const snapshot=new DatabaseSync(join(f.dir,files[0]),{readOnly:true});try{assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,31);assert.deepEqual(Buffer.from(snapshot.prepare("SELECT data FROM archive_assets WHERE id='asset'").get().data),Buffer.from([0,1,255]));}finally{snapshot.close();}}finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('failed schema31 role migration rolls back table replacement, bytes, old unique key and revision triggers',async ()=>{
  const f=legacy(),raw=new DatabaseSync(f.path);raw.exec("UPDATE app_meta SET value='invalid' WHERE key='archive_revision'");raw.close();
  try{await assert.rejects(()=>RivuDatabase.open(f.path),/归档修订记录无效/);const original=new DatabaseSync(f.path);try{assert.equal(original.prepare('PRAGMA user_version').get().user_version,31);assert.deepEqual(Buffer.from(original.prepare("SELECT data FROM archive_assets WHERE id='asset'").get().data),Buffer.from([0,1,255]));assert.throws(()=>original.exec("INSERT INTO archive_assets VALUES ('snapshot','a','v','snapshot','https://example.invalid/same','text/html',1,x'01')"),/UNIQUE/);assert.equal(original.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'archive_revision_archive_assets_%'").get().n,3);assert.equal(original.prepare("SELECT count(*) n FROM sqlite_master WHERE name='archive_assets_v32'").get().n,0);}finally{original.close();}}finally{rmSync(f.dir,{recursive:true,force:true});}
});
test('current schema refuses the old URL-only identity instead of silently hiding resource roles',async ()=>{
  const f=legacy(),raw=new DatabaseSync(f.path);raw.exec('PRAGMA user_version='+SCHEMA_VERSION);raw.close();try{await assert.rejects(()=>RivuDatabase.open(f.path),/归档资源身份索引无效/);assert.equal(readdirSync(f.dir).filter(name=>name.startsWith('pre-migration-')).length,0);}finally{rmSync(f.dir,{recursive:true,force:true});}
});
