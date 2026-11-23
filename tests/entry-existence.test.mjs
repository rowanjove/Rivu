import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-entry-exists-')),db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'Fixture',url:'https://example.invalid/feed',fetchInterval:0});db.addEntries(feed.id,[{title:'Large body',content:'<p>'+('正文'.repeat(100000))+'</p>',hash:'entry',media:[{kind:'image',url:'https://example.invalid/image',source:'body',mime:'image/png',title:null}]}]);return {directory,db,feed,id:db.entries()[0].id,close(){db.close();const path=relative(resolve(tmpdir()),resolve(directory));assert.ok(path.startsWith('rivu-entry-exists-')&&!path.startsWith('..')&&!isAbsolute(path));rmSync(directory,{recursive:true,force:true});}};}
test('existence matches full entry membership, uses a covering lookup and excludes orphan sources',()=>{
  const f=fixture();try{assert.equal(f.db.hasEntry(f.id),!!f.db.entry(f.id));assert.equal(f.db.hasEntry('missing'),false);const plan=f.db.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=? LIMIT 1').all(f.id);assert.ok(plan.some(row=>/COVERING INDEX entries_list_metadata/.test(row.detail)));f.db.db.exec('PRAGMA foreign_keys=OFF');f.db.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(f.id);assert.equal(f.db.hasEntry(f.id),!!f.db.entry(f.id));assert.equal(f.db.hasEntry(f.id),false);}finally{f.close();}
});
test('media and reading-position APIs do not load bodies while preserving status and validation',async()=>{
  const f=fixture(),service=createService(f.db,'token'),request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
  try{f.db.entry=()=>{throw Error('full body lookup must not run');};assert.equal((await request('GET',`/api/entries/${f.id}/media`)).json().length,1);assert.deepEqual((await request('GET',`/api/entries/${f.id}/reading-position`)).json(),{progress:0});assert.equal((await request('PUT',`/api/entries/${f.id}/reading-position`,{progress:0.75})).json().progress,0.75);assert.equal((await request('GET',`/api/entries/${f.id}/reading-position`)).json().progress,0.75);for(const value of [-1,2,null,'0.5'])assert.equal((await request('PUT',`/api/entries/${f.id}/reading-position`,{progress:value})).statusCode,400);for(const path of ['media','reading-position'])assert.equal((await request('GET',`/api/entries/missing/${path}`)).statusCode,404);assert.equal((await request('PUT','/api/entries/missing/reading-position',{progress:0.5})).statusCode,404);assert.equal((await service.app.inject({url:`/api/entries/${f.id}/media`})).statusCode,401);}finally{await service.stop();f.close();}
});
