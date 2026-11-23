import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {EntryReader} from '../dist-server/entry-reader.js';
import {createService} from '../dist-server/service.js';
const marker='entry-worker-json-fixture';
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-entry-json-')),db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'来源 中文😀',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'"引号" 中文😀',content:`<p>${marker}${'多字节正文😀'.repeat(90000)}</p>`,description:'\n\t"\\\u0000',hash:'fixture'}]);const id=db.entries()[0].id;return {directory,db,id,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
test('serialized article snapshot transfers exact JSON bytes and retains ordinary object readers',async()=>{
 const f=fixture(),reader=new EntryReader(resolve('dist-server/entry-read-worker.cjs'));
 try{const expected=JSON.parse(JSON.stringify(f.db.entry(f.id))),input={databasePath:f.db.path,kind:'entry',entryId:f.id};const result=await reader.read({...input,serialize:true});assert.ok(result.json instanceof ArrayBuffer);assert.deepEqual(JSON.parse(new TextDecoder().decode(result.json)),expected);assert.deepEqual(await reader.read(input),expected);assert.equal(await reader.read({...input,entryId:'missing',serialize:true}),undefined);f.db.updateEntry(f.id,{read:true,starred:true});assert.deepEqual(JSON.parse(new TextDecoder().decode((await reader.read({...input,serialize:true})).json)),JSON.parse(JSON.stringify(f.db.entry(f.id))));}finally{await reader.stop();f.close();}
});
test('article HTTP response preserves full fields without main-thread large JSON serialization',async()=>{
 const f=fixture(),expected=JSON.parse(JSON.stringify(f.db.entry(f.id))),service=createService(f.db,'token'),stringify=JSON.stringify;let serialized=0;
 const request=(url,token='token')=>service.app.inject({method:'GET',url,headers:{'x-rivu-token':token}});
 JSON.stringify=function(value,...args){if(value&&typeof value==='object'&&typeof value.content==='string'&&value.content.includes(marker))serialized++;return stringify.call(this,value,...args);};
 try{JSON.stringify(expected);assert.equal(serialized,1,'instrumentation detects the original object serialization');serialized=0;f.db.entry=()=>{throw Error('main article query forbidden');};const response=await request(`/api/entries/${f.id}`);assert.equal(response.statusCode,200,response.body.slice(0,100));assert.match(response.headers['content-type'],/^application\/json/);assert.deepEqual(response.json(),expected);assert.equal(serialized,0);assert.equal((await request('/api/entries/missing')).statusCode,404);assert.equal((await request(`/api/entries/${f.id}`,'wrong')).statusCode,401);}finally{JSON.stringify=stringify;await service.stop();f.close();}
});

