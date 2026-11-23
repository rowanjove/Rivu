import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createBackup,inspectBackup} from '../dist-server/backup.js';
import {inspectBackupInWorker,restoreBackupInWorker,recoverRestoreInWorker,withBackupSnapshot} from '../dist-server/backup-inspection.js';
const worker=resolve('dist-server/backup-inspection-worker.cjs'),task=resolve('dist-server/backup-inspection-task.cjs');

test('confirmation and restore keep the inspected bytes when the selected source is replaced, with cleanup on cancel/error',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-pinned-backup-')),source=join(dir,'selected.zip');let pinned;
 try{
  writeFileSync(source,'confirmed original');
  await withBackupSnapshot(source,async snapshot=>{pinned=snapshot;writeFileSync(source,'different replacement');assert.equal(readFileSync(snapshot,'utf8'),'confirmed original');});
  assert.equal(existsSync(pinned),false);
  await assert.rejects(withBackupSnapshot(source,async snapshot=>{pinned=snapshot;throw Error('cancel fixture');}),/cancel fixture/);
  assert.equal(existsSync(pinned),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('worker preflight preserves actual validation and rejects invalid archives without changing live data',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-inspect-worker-')),model=new RivuDatabase(join(dir,'rivu.db'));
 try{
  const feed=model.addFeed({title:'Local',url:'https://example.invalid/'});model.addEntries(feed.id,[{title:'Offline',content:'原始正文😀',hash:'one'}]);
  const archive=join(dir,'backup.zip'),bad=join(dir,'invalid.zip');writeFileSync(bad,'invalid');
  await createBackup(model,dir,archive);const before=model.entries();
  assert.deepEqual(await inspectBackupInWorker(worker,task,archive),await inspectBackup(archive));
  await assert.rejects(inspectBackupInWorker(worker,task,bad));
  assert.deepEqual(model.entries(),before);
 }finally{model.close();rmSync(dir,{recursive:true,force:true});}
});

test('CPU-heavy worker preflight leaves the caller event loop responsive and reports module failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-inspect-responsive-')),slow=join(dir,'slow.cjs'),broken=join(dir,'broken.cjs');
 try{
  writeFileSync(slow,"exports.inspectBackup=async()=>{const end=Date.now()+200;while(Date.now()<end){}return {schemaVersion:43,hasSettings:false,includesSecrets:false};};");
  writeFileSync(broken,"throw Error('fixture module failure');");
  let completed=false;const pending=inspectBackupInWorker(worker,slow,'unused').then(value=>{completed=true;return value;});
  await new Promise(done=>setTimeout(done,30));assert.equal(completed,false,'caller timer runs while worker is still computing');
  assert.equal((await pending).schemaVersion,43);
  await assert.rejects(inspectBackupInWorker(worker,broken,'unused'),/fixture module failure/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('restore worker replaces a closed target using actual backup validation and preserves it on bad input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-restore-worker-')),source=join(dir,'source'),target=join(dir,'target');
 let origin=new RivuDatabase(join(source,'rivu.db')),destination;
 try{
  const feed=origin.addFeed({title:'Saved',url:'https://example.invalid/feed'});origin.addEntries(feed.id,[{title:'Restored body',content:'original 😀',hash:'one'}]);
  const archive=join(dir,'backup.zip');await createBackup(origin,source,archive);origin.close();origin=null;
  destination=new RivuDatabase(join(target,'rivu.db'));destination.close();destination=null;
  await restoreBackupInWorker(worker,task,archive,target);
  destination=new RivuDatabase(join(target,'rivu.db'));assert.equal(destination.entries()[0].title,'Restored body');destination.close();destination=null;
  const before=readFileSync(join(target,'rivu.db')),bad=join(dir,'bad.zip');writeFileSync(bad,'bad input');
  await assert.rejects(restoreBackupInWorker(worker,task,bad,target));assert.deepEqual(readFileSync(join(target,'rivu.db')),before);
 }finally{origin?.close();destination?.close();rmSync(dir,{recursive:true,force:true});}
});

test('CPU-heavy restore work does not block caller timers and never acknowledges failure as success',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-restore-responsive-')),slow=join(dir,'slow.cjs'),broken=join(dir,'broken.cjs');
 try{
  writeFileSync(slow,"exports.restoreBackup=async()=>{const end=Date.now()+200;while(Date.now()<end){}};");
  writeFileSync(broken,"exports.restoreBackup=async()=>{throw Error('restore fixture failed');};");
  let completed=false;const pending=restoreBackupInWorker(worker,slow,'unused',dir).then(()=>completed=true);
  await new Promise(done=>setTimeout(done,30));assert.equal(completed,false);await pending;assert.equal(completed,true);
  await assert.rejects(restoreBackupInWorker(worker,broken,'unused',dir),/restore fixture failed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});


test('production restore killed after database rename recovers the old pair through the startup worker API',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-real-restore-crash-')),source=join(dir,'source'),target=join(dir,'target');let model;
 try{
  model=new RivuDatabase(join(source,'rivu.db'));let feed=model.addFeed({title:'New',url:'https://example.invalid/new'});model.addEntries(feed.id,[{title:'New entry',hash:'new'}]);
  writeFileSync(join(source,'settings.json'),JSON.stringify({marker:'new'}));const archive=join(dir,'backup.zip');await createBackup(model,source,archive);model.close();model=null;
  model=new RivuDatabase(join(target,'rivu.db'));feed=model.addFeed({title:'Old',url:'https://example.invalid/old'});model.addEntries(feed.id,[{title:'Old entry',hash:'old'}]);model.close();model=null;
  const oldSettings=JSON.stringify({marker:'old'});writeFileSync(join(target,'settings.json'),oldSettings);
  const crashTask=join(dir,'crash.cjs');writeFileSync(crashTask,`const fs=require('node:fs/promises'),rename=fs.rename;fs.rename=async(from,to)=>{await rename(from,to);if(String(to)===${JSON.stringify(join(target,'rivu.db'))})process.exit(17);};module.exports=require(${JSON.stringify(task)});`);
  await assert.rejects(restoreBackupInWorker(worker,crashTask,archive,target),/17/);
  assert.ok(existsSync(join(target,'restore-journal.json')));assert.equal(readFileSync(join(target,'settings.json'),'utf8'),oldSettings);
  assert.deepEqual(await recoverRestoreInWorker(worker,task,target),{recovered:true,outcome:'rolled-back'});
  model=new RivuDatabase(join(target,'rivu.db'));assert.equal(model.entries()[0].title,'Old entry');assert.equal(readFileSync(join(target,'settings.json'),'utf8'),oldSettings);
  assert.equal(existsSync(join(target,'restore-journal.json')),false);model.close();model=null;
  assert.deepEqual(await recoverRestoreInWorker(worker,task,target),{recovered:false});
 }finally{model?.close();rmSync(dir,{recursive:true,force:true});}
});


test('committed restore survives Worker exit before success reply and is finalized by caller',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rivu-restore-ack-crash-')),source=join(dir,'source'),target=join(dir,'target');let model;
 try{
  model=new RivuDatabase(join(source,'rivu.db'));const feed=model.addFeed({title:'New',url:'https://example.invalid/new'});model.addEntries(feed.id,[{title:'Committed entry',hash:'new'}]);writeFileSync(join(source,'settings.json'),JSON.stringify({marker:'new'}));
  const archive=join(dir,'backup.zip');await createBackup(model,source,archive);model.close();model=null;
  model=new RivuDatabase(join(target,'rivu.db'));model.close();model=null;writeFileSync(join(target,'settings.json'),JSON.stringify({marker:'old'}));
  const crashTask=join(dir,'ack-crash.cjs');writeFileSync(crashTask,`const task=require(${JSON.stringify(task)});exports.recoverRestoreJournal=task.recoverRestoreJournal;exports.restoreBackup=async(...args)=>{await task.restoreBackup(...args);process.exit(19);};`);
  await restoreBackupInWorker(worker,crashTask,archive,target);
  model=new RivuDatabase(join(target,'rivu.db'));assert.equal(model.entries()[0].title,'Committed entry');assert.equal(JSON.parse(readFileSync(join(target,'settings.json'),'utf8')).marker,'new');assert.equal(existsSync(join(target,'restore-journal.json')),false);
 }finally{model?.close();rmSync(dir,{recursive:true,force:true});}
});
