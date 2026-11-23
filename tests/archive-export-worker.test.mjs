import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import AdmZip from 'adm-zip';
import {RivuDatabase} from '../dist-server/database.cjs';
import {saveArchive} from '../dist-server/archive.js';
import {ArchiveExporter} from '../dist-server/archive-exporter.js';
import {createService} from '../dist-server/service.js';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-export-worker-')),db=new RivuDatabase(join(dir,'rivu.db')),feed=db.addFeed({title:'Local source',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Snapshot title',url:'https://example.invalid/article',content:'<p>Version one</p>',hash:'first'}]);return {dir,db,id:db.entries()[0].id};}
test('real archive Worker exports a consistent snapshot after concurrent deletion, preserving versions and exact asset bytes',async()=>{
  const f=fixture(),exporter=new ArchiveExporter(resolve('dist-server/archive-export-worker.cjs'));
  try{
    const first=await saveArchive(f.db,f.id);f.db.setFullContent(f.id,'<p>Version two</p><img src="https://example.invalid/image.png"><script>unsafe()</script>');const second=await saveArchive(f.db,f.id);
    const bytes=randomBytes(12*1024*1024),asset=randomUUID();f.db.db.prepare('INSERT INTO archive_assets(id,archive_id,version_id,kind,url,mime,bytes,data) VALUES (?,?,?,?,?,?,?,?)').run(asset,second.id,second.version_id,'image','https://example.invalid/image.png','image/png',bytes.length,bytes);
    const destination=join(f.dir,'article.zip');let snapshot=false;
    await exporter.export(f.db.path,second.id,destination,()=>{snapshot=true;f.db.db.prepare('DELETE FROM permanent_archives WHERE id=?').run(second.id);assert.equal(f.db.db.prepare('SELECT count(*) n FROM archive_assets').get().n,0);});
    assert.equal(snapshot,true);const zip=new AdmZip(destination),manifest=JSON.parse(zip.readAsText('metadata.json'));assert.equal(manifest.versions.length,2);assert.equal(manifest.versions[0].versionId,first.version_id);assert.match(zip.readAsText('versions/001.html'),/Version one/);assert.match(zip.readAsText('index.html'),/Version two/);assert.doesNotMatch(zip.readAsText('index.html'),/<script>/);assert.match(zip.readAsText('versions/002.html'),/\.\.\/assets\//);
    const exported=zip.getEntries().find(row=>row.entryName.includes(asset));assert.ok(exported);assert.equal(createHash('sha256').update(exported.getData()).digest('hex'),createHash('sha256').update(bytes).digest('hex'));assert.equal(readdirSync(f.dir).some(name=>name.endsWith('.tmp')),false);
  }finally{await exporter.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('archive Worker failure cleans only its staging file and preserves an existing destination',async()=>{
  const f=fixture(),worker=join(f.dir,'failed.cjs'),destination=join(f.dir,'existing.zip');writeFileSync(destination,'existing bytes');writeFileSync(worker,"const {workerData}=require('node:worker_threads');require('node:fs').writeFileSync(workerData.input.temporaryPath,'partial');throw Error('fixture failure');");const exporter=new ArchiveExporter(worker);
  try{await assert.rejects(exporter.export(f.db.path,'missing',destination),error=>error.outcomeUnknown&&error.destination===destination);assert.equal(readFileSync(destination,'utf8'),'existing bytes');assert.equal(readdirSync(f.dir).some(name=>name.endsWith('.tmp')),false);}finally{await exporter.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('archive export queue is bounded and stop drains accepted jobs before refusing new exports',async()=>{
  const f=fixture(),worker=join(f.dir,'slow.cjs');writeFileSync(worker,"const {workerData,parentPort}=require('node:worker_threads');setTimeout(()=>{require('node:fs').writeFileSync(workerData.input.destination,'complete');parentPort.postMessage({result:workerData.input.destination});},150);");const exporter=new ArchiveExporter(worker,undefined,1);
  try{const a=exporter.export(f.db.path,'a',join(f.dir,'a.zip')),b=exporter.export(f.db.path,'b',join(f.dir,'b.zip'));await assert.rejects(exporter.export(f.db.path,'c',join(f.dir,'c.zip')),error=>error.resourceBusy&&error.statusCode===503);const stopped=exporter.stop();await assert.rejects(exporter.export(f.db.path,'c',join(f.dir,'c.zip')),/已关闭/);await Promise.all([a,b,stopped]);assert.equal(readFileSync(join(f.dir,'a.zip'),'utf8'),'complete');assert.equal(readFileSync(join(f.dir,'b.zip'),'utf8'),'complete');}finally{await exporter.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('service waits for accepted archive export on shutdown and propagates a missing archive as 404',async()=>{
  const f=fixture(),service=createService(f.db,'token');
  try{await assert.rejects(service.exportPermanentArchive('missing',join(f.dir,'missing.zip')),error=>error.statusCode===404);const record=await saveArchive(f.db,f.id),pending=service.exportPermanentArchive(record.id,join(f.dir,'accepted.zip')),stopped=service.stop();await assert.rejects(service.exportPermanentArchive(record.id,join(f.dir,'new.zip')),/关闭/);await Promise.all([pending,stopped]);assert.match(new AdmZip(join(f.dir,'accepted.zip')).readAsText('index.html'),/Version one/);}finally{await service.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
