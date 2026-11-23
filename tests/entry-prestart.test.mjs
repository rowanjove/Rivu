import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EntryReader} from '../dist-server/entry-reader.js';
import {RivuDatabase} from '../dist-server/database.cjs';
const worker=resolve('dist-server/entry-read-worker.cjs'),task=resolve('dist-server/entry-read-task.cjs');
async function until(check){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'worker module not started');await new Promise(resolve=>setTimeout(resolve,10));}}
test('prestart reuses one idle worker, reads only after submission and sees the first current WAL snapshot',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-prestart-')),ready=join(directory,'started'),called=join(directory,'called'),modulePath=join(directory,'task.cjs'),db=new RivuDatabase(join(directory,'rivu.db'));
 writeFileSync(modulePath,String.raw`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(ready)},'start\n');const {readEntrySnapshot}=require(${JSON.stringify(task)});exports.readEntrySnapshot=input=>{fs.appendFileSync(${JSON.stringify(called)},'read\n');return readEntrySnapshot(input);};`);
 const reader=new EntryReader(worker,modulePath);
 try{reader.prestart();reader.prestart();await until(()=>existsSync(ready));assert.equal(readFileSync(ready,'utf8'),'start\n');assert.equal(existsSync(called),false);const feed=db.addFeed({title:'New',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'After start',content:'new body',hash:'one'}]);const id=db.entries()[0].id;const row=await reader.read({databasePath:db.path,kind:'entry',entryId:id});assert.equal(row.title,'After start');assert.equal(row.content,'new body');assert.equal(readFileSync(ready,'utf8'),'start\n');assert.equal(readFileSync(called,'utf8'),'read\n');await reader.stop();assert.throws(()=>reader.prestart(),error=>error.statusCode===503);}finally{await reader.stop();db.close();rmSync(directory,{recursive:true,force:true});}
});
test('stop terminates a prestarted worker with a hung module without waiting for the read timeout',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-prestart-hung-')),ready=join(directory,'ready'),modulePath=join(directory,'hung.cjs');
 writeFileSync(modulePath,`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`);
 const reader=new EntryReader(worker,modulePath);let timer;
 try{reader.prestart();await until(()=>existsSync(ready));await Promise.race([reader.stop(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('idle stop waited for job timeout')),2000);})]);await assert.rejects(reader.read({databasePath:'unused',kind:'entry',entryId:'unused'}),error=>error.statusCode===503);}finally{clearTimeout(timer);await reader.stop();rmSync(directory,{recursive:true,force:true});}
});
