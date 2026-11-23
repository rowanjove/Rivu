import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
import {EntryReader} from '../dist-server/entry-reader.js';
const worker=resolve('dist-server/entry-read-worker.cjs'),task=resolve('dist-server/entry-read-task.cjs');
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('preview blocked another operation')),10000);})]);}finally{clearTimeout(timer);}}
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-delete-preview-')),db=new RivuDatabase(join(directory,'rivu.db'));
 const feeds=[0,1,2].map(i=>db.addFeed({title:'来源😀'+i,url:'https://example.invalid/'+i,fetchInterval:0}));
 for(const feed of feeds)db.addEntries(feed.id,[{title:'一',content:'内容',hash:'one'},{title:'二',hash:'two'}]);
 const now=new Date().toISOString(),entry=db.entries({feedId:feeds[0].id})[0];db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('archive',entry.id,feeds[0].id,'来源😀0','保留',null,now,now);
 return {directory,db,feeds,close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}

test('preview raw totals include read and archived entries, handle empty sources and refresh after commits',async()=>{
 const f=fixture(),reader=new EntryReader(worker);
 try{
  const feed=f.db.addFeed({title:'空',url:'https://example.invalid/empty',fetchInterval:0}),preview=()=>reader.read({databasePath:f.db.path,kind:'feed_delete_preview',feedId:feed.id});
  assert.equal((await preview()).entriesToDelete,0);
  f.db.addEntries(feed.id,[{title:'已读归档',content:'raw count',hash:'new'}]);const entry=f.db.entries({feedId:feed.id})[0];f.db.updateEntry(entry.id,{read:true,archived:true});
  assert.equal((await preview()).entriesToDelete,1);f.db.db.prepare('DELETE FROM entries WHERE id=?').run(entry.id);assert.equal((await preview()).entriesToDelete,0);
 }finally{await reader.stop();f.close();}
});

test('destructive deletion independently recounts primary rows when a preview projection is inconsistent',async()=>{
 const f=fixture(),service=createService(f.db,'token');
 try{
  f.db.db.prepare('UPDATE rivu_source_entry_counts SET entry_count=99 WHERE feed_id=?').run(f.feeds[0].id);
  const headers={'x-rivu-token':'token'},preview=await service.app.inject({method:'GET',url:'/api/feeds/'+f.feeds[0].id+'/delete-preview',headers});assert.equal(preview.statusCode,200);assert.equal(preview.json().entriesToDelete,99);
  const response=await service.app.inject({method:'DELETE',url:'/api/feeds/'+f.feeds[0].id,headers,payload:{expected:{entriesToDelete:99,archivesPreserved:1}}});
  assert.equal(response.statusCode,409,response.body);assert.ok(f.db.feed(f.feeds[0].id));assert.equal(f.db.entries({feedId:f.feeds[0].id}).length,2);
 }finally{await service.stop();f.close();}
});

test('delete preview reader preserves exact public results and validation failures without writing',async()=>{
 const f=fixture(),reader=new EntryReader(worker);
 try{
  const meta=f.db.db.prepare('SELECT * FROM app_meta ORDER BY key').all();
  assert.deepEqual(await reader.read({databasePath:f.db.path,kind:'feed_delete_preview',feedId:f.feeds[0].id}),{feedId:f.feeds[0].id,title:'来源😀0',entriesToDelete:2,archivesPreserved:1});
  assert.deepEqual(await reader.read({databasePath:f.db.path,kind:'feeds_delete_preview',selection:{ids:f.feeds.slice(0,2).map(f=>f.id)}}),{feedsToDelete:2,entriesToDelete:4,archivesPreserved:1});
  for(const selection of [null,{},[],{ids:[]},{ids:[f.feeds[0].id,f.feeds[0].id]},{ids:['bad']},{ids:Array(2001).fill(f.feeds[0].id)}])await assert.rejects(reader.read({databasePath:f.db.path,kind:'feeds_delete_preview',selection}),error=>error.statusCode===400);
  await assert.rejects(reader.read({databasePath:f.db.path,kind:'feed_delete_preview',feedId:'missing'}),error=>error.statusCode===404);
  await assert.rejects(reader.read({databasePath:f.db.path,kind:'feeds_delete_preview',selection:{ids:['00000000-0000-0000-0000-000000000000']}}),error=>error.statusCode===409);
  assert.deepEqual(f.db.db.prepare('SELECT * FROM app_meta ORDER BY key').all(),meta);assert.equal(f.db.entries().length,6);
 }finally{await reader.stop();f.close();}
});

for(const single of [true,false])test((single?'single':'bulk')+' preview snapshot releases the write lease and has an independent read queue',async()=>{
 const f=fixture(),gate=join(f.directory,'release'),ready=join(f.directory,'ready'),custom=join(f.directory,'held.cjs');
 writeFileSync(custom,`const task=require(${JSON.stringify(task)});Object.assign(exports,task);exports.readEntrySnapshot=(input,onSnapshot,...args)=>task.readEntrySnapshot(input,()=>{if(input.kind==='feed_delete_preview'||input.kind==='feeds_delete_preview'){const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');const end=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>end)throw Error('preview gate expired');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}},...args);`);
 const service=createService(f.db,'token',...Array(14).fill(undefined),worker,custom),request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
 const ids=f.feeds.slice(0,2).map(f=>f.id),preview=()=>single?request('GET','/api/feeds/'+ids[0]+'/delete-preview'):request('POST','/api/feeds/bulk-delete-preview',{ids});
 let held,deleting;
 try{
  held=preview();const deadline=Date.now()+10000;while(!existsSync(ready)){assert.ok(Date.now()<deadline,'preview did not reach Worker snapshot');await pause(10);}
  const other=await bounded(Promise.all(['/health','/api/feeds?icons=metadata','/api/entries'].map(url=>request('GET',url))));for(const response of other)assert.equal(response.statusCode,200,response.body);
  deleting=single?request('DELETE','/api/feeds/'+ids[0],{expected:{entriesToDelete:2,archivesPreserved:1}}):request('POST','/api/feeds/bulk',{ids,action:'delete',expected:{entriesToDelete:4,archivesPreserved:1}});
  assert.equal((await bounded(deleting)).statusCode,200);assert.equal(f.db.feed(ids[0]),undefined);
  writeFileSync(gate,'release');const response=await held;assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),single?{feedId:ids[0],title:'来源😀0',entriesToDelete:2,archivesPreserved:1}:{feedsToDelete:2,entriesToDelete:4,archivesPreserved:1});
  assert.equal((await preview()).statusCode,single?404:409);assert.equal(f.db.db.prepare('SELECT count(*) n FROM permanent_archives').get().n,1);assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{writeFileSync(gate,'release');await held?.catch(()=>{});await deleting?.catch(()=>{});await service.stop();f.close();}
});
