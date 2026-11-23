import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {FeedWriter} from '../dist-server/feed-writer.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');
const {feedWriteSnapshot}=require('../dist-server/feed-write-task.cjs');
const worker=resolve('dist-server/feed-write-worker.cjs');
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-feed-writer-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path),feed=db.addFeed({title:'源',url:'https://example.invalid/feed'}),writer=new FeedWriter(worker);return {directory,path,db,feed,writer};}
function batch(f,items){return {databasePath:f.path,expected:feedWriteSnapshot(f.db.feed(f.feed.id)),items};}
async function cleanup(f){await f.writer.stop();f.db.close();rmSync(f.directory,{recursive:true,force:true});}

test('worker commits articles, media, identities, FTS, rules and fetch state atomically while WAL readers see whole batches',async()=>{
  const f=fixture();let polling;
  try{
    f.db.addEntries(f.feed.id,[{title:'旧文章',guid:'old',url:'https://example.invalid/old',hash:'old'}]);
    const old=f.db.entries()[0];f.db.updateEntry(old.id,{read:true,starred:true,saved:true});const before=f.db.entry(old.id);
    f.db.db.prepare("INSERT INTO rules(id,name,priority,enabled,conditions,action_type,created_at,updated_at) VALUES ('save-rule','保存新增',0,1,?,'save','2026-10-01','2026-10-01')").run(JSON.stringify({titleKeyword:'新增'}));
    const seen=[],ticks=[];polling=setInterval(()=>{seen.push(Number(f.db.db.prepare('SELECT count(*) n FROM entries').get().n));ticks.push(performance.now());},10);
    const items=Array.from({length:600},(_,i)=>({guid:`new-${i}`,url:`https://example.invalid/${i}`,title:`新增文章 ${i}`,content:`<p>正文编号 ${i}</p>`,media:[{kind:'image',url:`https://example.invalid/${i}.png`,mime:null,source:'body',title:null}]}));
    const result=await f.writer.write(batch(f,items));clearInterval(polling);polling=undefined;
    assert.deepEqual(result,{added:600,total:600});assert.ok(seen.length>5);assert.ok(seen.every(count=>count===1||count===601));
    assert.equal(f.db.entries({query:'编号 599'}).length,1);assert.equal(f.db.entries({view:'images',limit:500}).length,500);
    assert.equal(Number(f.db.db.prepare('SELECT count(*) n FROM entry_identities').get().n),3004);
    assert.equal(Number(f.db.db.prepare('SELECT count(*) n FROM rule_matches').get().n),600);
    assert.ok(f.db.feed(f.feed.id).last_success_at);assert.deepEqual(f.db.entry(old.id),before);
    const replay=await f.writer.write(batch(f,items));assert.deepEqual(replay,{added:0,total:600});assert.deepEqual(f.db.entry(old.id),before);
    console.log(JSON.stringify({readerSamples:seen.length,maxTimerGapMs:Math.round(Math.max(...ticks.slice(1).map((at,i)=>at-ticks[i])))}));
  }finally{clearInterval(polling);await cleanup(f);}
});

test('a late identity conflict or rule failure rolls back the entire batch, indexes and fetch success',async()=>{
  const f=fixture();
  try{
    f.db.addEntries(f.feed.id,[{guid:'a',url:'https://example.invalid/a',title:'A',hash:'a'},{guid:'b',url:'https://example.invalid/b',title:'B',hash:'b'}]);
    const before=f.db.feed(f.feed.id);
    await assert.rejects(f.writer.write(batch(f,[{guid:'new',title:'先写后回滚',content:'唯一回滚词'},{guid:'a',url:'https://example.invalid/b',title:'冲突'}])),error=>error.statusCode===409);
    assert.equal(f.db.entries().length,2);assert.equal(f.db.entries({query:'唯一回滚词'}).length,0);assert.equal(f.db.feed(f.feed.id).last_success_at,before.last_success_at);
    f.db.db.prepare("INSERT INTO rules(id,name,priority,enabled,conditions,action_type,created_at,updated_at) VALUES ('broken','损坏规则',0,1,'{bad','save','2026-10-01','2026-10-01')").run();
    await assert.rejects(f.writer.write(batch(f,[{guid:'after-rule',title:'规则失败回滚',content:'规则回滚词'}])));
    assert.equal(f.db.entries().length,2);assert.equal(f.db.entries({query:'规则回滚词'}).length,0);assert.equal(f.db.feed(f.feed.id).last_success_at,before.last_success_at);
    f.db.db.prepare("DELETE FROM rules WHERE id='broken'").run();assert.equal((await f.writer.write(batch(f,[{guid:'after-failure',title:'正常重试'}]))).added,1);
  }finally{await cleanup(f);}
});

test('worker rechecks source settings and authorization under its write transaction and never migrates old or absent files',async()=>{
  const f=fixture();
  try{
    for(const [field,value] of [['url','https://example.invalid/changed'],['allow_private',1],['type','custom_json'],['json_mapping','{}'],['enabled',0],['folder_authorized',1]]){
      const input=batch(f,[{guid:field,title:'旧授权结果'}]),original=f.db.feed(f.feed.id)[field];
      f.db.db.prepare(`UPDATE feeds SET ${field}=? WHERE id=?`).run(value,f.feed.id);
      await assert.rejects(f.writer.write(input),error=>error.statusCode===409);assert.equal(f.db.entries().length,0);
      f.db.db.prepare(`UPDATE feeds SET ${field}=? WHERE id=?`).run(original,f.feed.id);
    }
    const input=batch(f,[{title:'删除后的结果'}]);f.db.deleteFeed(f.feed.id);await assert.rejects(f.writer.write(input),error=>error.statusCode===404);
    const missing=join(f.directory,'missing.db');await assert.rejects(f.writer.write({...input,databasePath:missing}),/已初始化/);assert.equal(existsSync(missing),false);
    const legacyPath=join(f.directory,'legacy.db'),legacy=new DatabaseSync(legacyPath);legacy.exec('PRAGMA user_version=20');legacy.close();
    await assert.rejects(f.writer.write({...input,databasePath:legacyPath}),/不能创建或迁移/);
    const check=new DatabaseSync(legacyPath,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,20);assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode,'delete');check.close();assert.ok(!readdirSync(f.directory).some(name=>name.startsWith('pre-migration')));
  }finally{await cleanup(f);}
});

test('writer serializes accepted batches, drains on stop and rejects new work after closing',async()=>{
  const f=fixture();
  try{
    const one=f.writer.write(batch(f,[{guid:'one',title:'一'}])),two=f.writer.write(batch(f,[{guid:'two',title:'二'}])),stopping=f.writer.stop();
    assert.equal((await one).added,1);assert.equal((await two).added,1);await stopping;assert.equal(f.db.entries().length,2);
    await assert.rejects(f.writer.write(batch(f,[{title:'关闭后'}])),/已关闭/);
    assert.throws(()=>f.db.addEntries(f.feed.id,[],true),/已有事务/);
  }finally{await cleanup(f);}
});

test('fatal worker exit, invalid response and missing entry reject without poisoning a subsequent healthy worker',async()=>{
  const f=fixture(),modulePath=resolve('dist-server/feed-write-task.cjs');
  try{
    for(const [name,code] of [['exit',"require('node:worker_threads').parentPort.on('message',()=>process.exit(0))"],['invalid',"require('node:worker_threads').parentPort.on('message',()=>require('node:worker_threads').parentPort.postMessage({result:{added:-1,total:1}}))"],['missing',null]]){
      const path=join(f.directory,`${name}.cjs`);if(code)writeFileSync(path,code);
      const writer=new FeedWriter(path,modulePath);
      try{await assert.rejects(writer.write(batch(f,[{guid:name,title:'失败前'}])));assert.equal(f.db.entries().length,0);
        writeFileSync(path,readFileSync(worker));assert.equal((await writer.write(batch(f,[{guid:name,title:'修复后'}]))).added,1);
        f.db.db.prepare('DELETE FROM entries').run();
      }finally{await writer.stop();}
    }
  }finally{await cleanup(f);}
});
