import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
const buildDir=mkdtempSync(join(tmpdir(),'rivu-journal-module-')),modulePath=join(buildDir,'journal.mjs');
await build({entryPoints:['server/restore-journal.ts'],outfile:modulePath,bundle:true,platform:'node',format:'esm'});
const {beginRestoreJournal,markRestoreCommitted,recoverRestoreJournal}=await import(pathToFileURL(modulePath));
test.after(()=>rmSync(buildDir,{recursive:true,force:true}));
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-journal-')),id=randomUUID();for(const [name,body]of [['rivu.db','old-db'],['settings.json','old-settings'],[`before-restore-${id}.db`,'old-db'],[`before-restore-${id}.json`,'old-settings']])writeFileSync(join(dir,name),body);return {dir,id};}

test('actual Worker exit between pair replacements restores the old pair before reuse',async()=>{
 const {dir,id}=fixture();try{
  const worker=new Worker(`(async()=>{const {workerData}=require('node:worker_threads'),fs=require('node:fs/promises'),path=require('node:path');const api=await import(workerData.module);await api.beginRestoreJournal(workerData.dir,workerData.id,{hadDb:true,hadSettings:true,replaceSettings:true});await fs.writeFile(path.join(workerData.dir,'staged.db'),'new-db');await fs.rename(path.join(workerData.dir,'staged.db'),path.join(workerData.dir,'rivu.db'));process.exit(17);})();`,{eval:true,workerData:{module:pathToFileURL(modulePath).href,dir,id}});
  const code=await new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('exit',resolve);});assert.equal(code,17);
  assert.equal(readFileSync(join(dir,'rivu.db'),'utf8'),'new-db');
  // A stale half-written phase update must not prevent repeat recovery.
  writeFileSync(join(dir,`restore-journal-${id}.tmp`),'partial');
  assert.deepEqual(await recoverRestoreJournal(dir),{recovered:true,outcome:'rolled-back'});
  assert.equal(readFileSync(join(dir,'rivu.db'),'utf8'),'old-db');assert.equal(readFileSync(join(dir,'settings.json'),'utf8'),'old-settings');
  assert.deepEqual(await recoverRestoreJournal(dir),{recovered:false});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('committed pair survives cleanup recovery, including already removed rollback files',async()=>{
 const {dir,id}=fixture();try{
  await beginRestoreJournal(dir,id,{hadDb:true,hadSettings:true,replaceSettings:true});writeFileSync(join(dir,'rivu.db'),'new-db');writeFileSync(join(dir,'settings.json'),'new-settings');
  await markRestoreCommitted(dir);rmSync(join(dir,`before-restore-${id}.db`));
  assert.deepEqual(await recoverRestoreJournal(dir),{recovered:true,outcome:'committed'});
  assert.equal(readFileSync(join(dir,'rivu.db'),'utf8'),'new-db');assert.equal(readFileSync(join(dir,'settings.json'),'utf8'),'new-settings');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('missing rollback or corrupt path evidence fails closed without touching the current pair',async()=>{
 const {dir,id}=fixture();try{
  await assert.rejects(beginRestoreJournal(dir,'../escape',{hadDb:true,hadSettings:true,replaceSettings:true}));
  await beginRestoreJournal(dir,id,{hadDb:true,hadSettings:true,replaceSettings:true});writeFileSync(join(dir,'rivu.db'),'new-db');rmSync(join(dir,`before-restore-${id}.json`));
  await assert.rejects(recoverRestoreJournal(dir));assert.equal(readFileSync(join(dir,'rivu.db'),'utf8'),'new-db');assert.ok(existsSync(join(dir,'restore-journal.json')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('prepared restore with no previous files removes the uncommitted new pair',async()=>{
 const {dir,id}=fixture();try{
  await beginRestoreJournal(dir,id,{hadDb:false,hadSettings:false,replaceSettings:true});writeFileSync(join(dir,'rivu.db'),'new-db');writeFileSync(join(dir,'settings.json'),'new-settings');
  await recoverRestoreJournal(dir);assert.equal(existsSync(join(dir,'rivu.db')),false);assert.equal(existsSync(join(dir,'settings.json')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
