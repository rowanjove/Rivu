import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { AutoBackupManager } from '../dist-server/auto-backup.js';
import { inspectBackup, restoreBackup } from '../dist-server/backup.js';
import { createService } from '../dist-server/service.js';
const require=createRequire(import.meta.url);
const {RivuDatabase,SCHEMA_VERSION}=require('../dist-server/database.cjs');

test('automatic backup catches up, keeps seven valid ZIPs, excludes keys and retries errors',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-auto-backup-')),db=new RivuDatabase(join(dir,'rivu.db'));let clock=Date.parse('2026-09-26T00:00:00.000Z');
  const manager=new AutoBackupManager(db,dir,()=>clock);
  try{
    const feed=db.addFeed({title:'自动备份源',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'本地文章',content:'正文',hash:'one'}]);
    writeFileSync(join(dir,'settings.json'),JSON.stringify({ai:{apiKey:'test-secret',model:'fixture'}}));
    assert.equal((await manager.runDue()).ran,false);
    await assert.rejects(manager.configure({frequency:'hourly'}),/频率无效/);
    await manager.configure({frequency:'daily'});await manager.runDue();
    let status=await manager.status();assert.equal(status.backups.length,1);assert.equal(status.frequency,'daily');
    const first=join(dir,'backups',status.backups[0].name);assert.deepEqual(await inspectBackup(first),{schemaVersion:SCHEMA_VERSION,hasSettings:true,includesSecrets:false});
    assert.equal(JSON.parse(new AdmZip(first).getEntry('settings.json').getData().toString()).ai.apiKey,undefined);
    assert.equal((await manager.runDue()).ran,false);
    for(let day=1;day<=8;day++){clock+=24*60*60*1000;assert.equal((await manager.runDue()).ran,true);}
    status=await manager.status();assert.equal(status.backups.length,7);assert.equal(status.lastError,null);
    const retained=join(dir,'backups',status.backups.at(-1).name);const restoredDir=join(dir,'restored');await restoreBackup(retained,restoredDir);const restored=new RivuDatabase(join(restoredDir,'rivu.db'));try{assert.equal(restored.entries()[0].title,'本地文章');}finally{restored.close();}
    clock+=24*60*60*1000;writeFileSync(join(dir,'settings.json'),'{invalid');const failed=await manager.runDue();assert.equal(failed.ran,false);assert.match((await manager.status()).lastError,/JSON/);assert.equal((await manager.status()).backups.length,7);
    writeFileSync(join(dir,'settings.json'),JSON.stringify({ai:{apiKey:'test-secret'}}));assert.equal((await manager.runDue()).ran,true);assert.equal((await manager.status()).lastError,null);
    await manager.configure({frequency:'off'});clock+=30*24*60*60*1000;assert.equal((await manager.runDue()).ran,false);assert.equal((await manager.status()).backups.length,7);
  }finally{await manager.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('automatic backup API is local-token protected and validates frequency',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-auto-api-')),db=new RivuDatabase(join(dir,'rivu.db')),service=createService(db,'backup-token',join(dir,'settings.json'),dir);
  const headers={'x-rivu-token':'backup-token'};
  try{
    assert.equal((await service.app.inject({method:'GET',url:'/api/backups/automatic'})).statusCode,401);
    assert.equal((await service.app.inject({method:'PATCH',url:'/api/backups/automatic',headers,payload:{frequency:'hourly'}})).statusCode,400);
    const valid=await service.app.inject({method:'PATCH',url:'/api/backups/automatic',headers,payload:{frequency:'weekly'}});assert.equal(valid.statusCode,200);assert.equal(valid.json().frequency,'weekly');
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('clock rollback makes backup due and retention keeps the new backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-auto-clock-')),db=new RivuDatabase(join(dir,'rivu.db'));let clock=Date.parse('2026-09-26T00:00:00.000Z');
  const manager=new AutoBackupManager(db,dir,()=>clock),day=24*60*60*1000;
  try{
    await manager.configure({frequency:'daily'});await manager.runDue();
    for(let index=0;index<7;index++){clock+=day;assert.equal((await manager.runDue()).ran,true);}
    assert.equal((await manager.status()).backups.length,7);
    clock-=10*day;
    assert.equal((await manager.status()).nextDueAt,new Date(clock).toISOString());
    const result=await manager.runDue();assert.equal(result.ran,true);
    const status=await manager.status();assert.equal(status.backups.length,7);assert.ok(status.backups.some(item=>item.name===result.name));
    assert.equal((await manager.runDue()).ran,false);
  }finally{await manager.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
