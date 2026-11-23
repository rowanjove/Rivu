import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectBackup } from '../dist-server/backup.js';
import { createService } from '../dist-server/service.js';
const require=createRequire(import.meta.url);
const {RivuDatabase}=require('../dist-server/database.cjs');

test('database maintenance runs in background, protects data, rebuilds search and removes stale cache metadata',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-maintenance-')),db=new RivuDatabase(join(dir,'rivu.db'));
  const service=createService(db,'maintenance-token',join(dir,'settings.json'),dir),headers={'x-rivu-token':'maintenance-token'};
  try{
    const feed=db.addFeed({title:'维护测试',url:'https://example.com/feed'});db.addEntries(feed.id,[{title:'可检索的星际探测',content:'星际探测正文',hash:'one'}]);const entry=db.entries()[0];
    db.setFullContent(entry.id,'<p>深空航行独有词</p>');
    assert.equal(db.entries({query:'深空航行'}).length,1);
    db.db.exec("INSERT INTO entry_fts(entry_fts) VALUES('delete-all')");
    db.db.exec('DELETE FROM entry_pair_fts');
    assert.equal(db.entries({query:'星际探测'}).length,0);
    assert.equal(db.entries({query:'星际'}).length,0);
    db.saveCachedImage('https://example.com/missing.png',`${'a'.repeat(64)}.png`,'image/png',123);
    assert.equal((await service.app.inject({method:'POST',url:'/api/storage/maintenance'})).statusCode,401);
    const started=await service.app.inject({method:'POST',url:'/api/storage/maintenance',headers,payload:{}});assert.equal(started.statusCode,200);assert.equal(started.json().running,true);
    assert.ok(Object.hasOwn(started.json(),'snapshotPercent'));
    assert.equal((await service.app.inject({method:'POST',url:'/api/storage/maintenance',headers,payload:{}})).statusCode,409);
    assert.equal((await service.app.inject({method:'GET',url:'/health',headers})).statusCode,200);
    const queuedWrite=service.app.inject({method:'PATCH',url:`/api/entries/${entry.id}`,headers,payload:{read:true}});
    const queuedExternal=service.withDatabaseAccess(()=>db.addFeed({title:'IPC 导入模拟',url:'https://example.com/ipc'}));
    let status;const deadline=Date.now()+30_000;
    do{status=(await service.app.inject({method:'GET',url:'/api/storage/maintenance',headers})).json();if(!status.running)break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
    assert.equal(status.running,false);assert.equal(status.lastError,null);assert.equal(status.lastResult.removedCacheRows,1);
    assert.ok(existsSync(status.lastResult.backupPath));assert.equal((await inspectBackup(status.lastResult.backupPath)).schemaVersion,SCHEMA_VERSION);
    assert.equal(db.cachedImage('https://example.com/missing.png'),undefined);
    assert.equal((await queuedWrite).statusCode,200);assert.equal(db.entry(entry.id).read,1);
    assert.equal((await queuedExternal).title,'IPC 导入模拟');
    assert.equal(db.entries({query:'星际探测'})[0].title,'可检索的星际探测');
    assert.equal(db.entries({query:'星际'})[0].title,'可检索的星际探测');
    assert.equal(db.entries({query:'星'})[0].title,'可检索的星际探测');
    assert.equal(db.entries({query:'深空航行'})[0].title,'可检索的星际探测');
    assert.ok(db.feeds().some(item=>item.title==='维护测试'));
    assert.ok(status.lastResult.afterBytes>0);
    writeFileSync(join(dir,'backups','manual-keep.zip'),'manual backup fixture');
    for(let run=0;run<3;run++){
      assert.equal((await service.app.inject({method:'POST',url:'/api/storage/maintenance',headers,payload:{}})).statusCode,200);
      do{status=(await service.app.inject({method:'GET',url:'/api/storage/maintenance',headers})).json();if(!status.running)break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline+30_000);
      assert.equal(status.lastError,null);
    }
    const files=readdirSync(join(dir,'backups'));
    assert.equal(files.filter(name=>name.startsWith('rivu-maintenance-')).length,3);
    assert.ok(files.includes('manual-keep.zip'));
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('maintenance drains an IPC database operation that started earlier',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-maintenance-drain-')),db=new RivuDatabase(join(dir,'rivu.db'));
  const service=createService(db,'drain-token',join(dir,'settings.json'),dir),headers={'x-rivu-token':'drain-token'};
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  try{
    const external=service.withDatabaseAccess(async()=>{entered();await hold;return db.addFeed({title:'先开始的导入',url:'https://example.com/earlier'});});
    await started;
    const response=await service.app.inject({method:'POST',url:'/api/storage/maintenance',headers,payload:{}});assert.equal(response.statusCode,200);
    assert.equal((await service.app.inject({method:'GET',url:'/api/storage/maintenance',headers})).json().phase,'draining');
    release();await external;
    let status;const deadline=Date.now()+30_000;
    do{status=(await service.app.inject({method:'GET',url:'/api/storage/maintenance',headers})).json();if(!status.running)break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
    assert.equal(status.lastError,null);assert.ok(status.lastResult);assert.ok(db.feeds().some(item=>item.title==='先开始的导入'));
  }finally{release?.();await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
