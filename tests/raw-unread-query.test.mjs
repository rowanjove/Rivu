import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';
import {queryEntries as legacy} from './fixtures/schema36-entry-query.mjs';
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'rivu-raw-unread-')),model=new RivuDatabase(join(directory,'rivu.db')),category=model.addCategory('category');
 const a=model.addFeed({title:'Source A',url:'https://example.invalid/a',categoryId:category.id}),b=model.addFeed({title:'Source B',url:'https://example.invalid/b'});
 for(const feed of [a,b])model.addEntries(feed.id,Array.from({length:80},(_,index)=>({title:'中文 article '+index,content:'正文 '+index,publishedAt:index%7===0?undefined:`2026-01-${String(index%20+1).padStart(2,'0')}T00:00:00Z`,hash:feed.id+'-'+index})));
 const ids=model.entries({limit:160}).map(row=>row.id);
 for(const [id,type]of [['mute','mute'],['block','block']])model.db.prepare("INSERT INTO rules(id,name,conditions,action_type,created_at,updated_at) VALUES (?,?,'{}',?,'2026','2026')").run(id,id,type);
 for(let index=0;index<ids.length;index++){
  if(index%4===0)model.updateEntry(ids[index],{read:true});
  if(index%5===0)model.db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES ('mute',?,'2026')").run(ids[index]);
  if(index%9===0)model.db.prepare("INSERT INTO rule_matches(rule_id,entry_id,created_at) VALUES ('block',?,'2026')").run(ids[index]);
  if(index%11===0)model.setFilterDecision(ids[index],{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'fixture'});
 }
 return {model,a,b,category,ids,close(){model.close();rmSync(directory,{recursive:true,force:true});}};
}
function compare(f,options){for(const listOnly of [true,false])assert.deepEqual(plain(f.model.entries({...options,listOnly})),plain(legacy(f.model.db,{...options,listOnly})),JSON.stringify({...options,listOnly}));}
test('raw unread retains muted rows and matches frozen semantics across offsets, cursors and scopes',()=>{
 const f=fixture();try{
  const all=f.model.entries({query:'is:unread',limit:500}),visible=f.model.entries({view:'unread',limit:500});assert.ok(all.length>visible.length);assert.ok(all.some(row=>row.rule_muted===1));
  for(const options of [{query:'is:unread'},{query:'is:unread is:blocked'},{query:'is:unread after:2026-01-03 before:2026-01-19'},{query:'is:unread feed:"Source A"'},{query:'is:unread',categoryId:f.category.id},{query:'is:unread',feedId:f.b.id},{query:'is:unread is:muted'},{query:'is:unread 中文'}]){
   for(const offset of [0,1,40,100,160])compare(f,{...options,offset,limit:17});
   const anchor=legacy(f.model.db,{...options,offset:20,limit:5}).at(-1);if(anchor)compare(f,{...options,limit:17,cursor:{sortTime:anchor.published_at||anchor.fetched_at,id:anchor.id}});
  }
 }finally{f.close();}
});
test('raw unread page respects uncommitted visibility changes, rollback and missing-source slots',()=>{
 const f=fixture();try{
  f.model.db.exec('BEGIN');try{f.model.db.exec("UPDATE rules SET enabled=0 WHERE id='block'");f.model.updateEntry(f.ids[3],{read:true});compare(f,{query:'is:unread',offset:30,limit:20});}finally{f.model.db.exec('ROLLBACK');}
  compare(f,{query:'is:unread',offset:30,limit:20});
  f.model.db.exec('PRAGMA foreign_keys=OFF');f.model.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(f.ids[3]);f.model.db.exec('PRAGMA foreign_keys=ON');
  for(const offset of [0,1,50,100])compare(f,{query:'is:unread',offset,limit:20});
 }finally{f.close();}
});

test('raw unread service worker preserves every public list field against frozen query semantics',async()=>{
 const f=fixture(),service=createService(f.model,'raw-unread-test');
 try{
  for(const options of [{query:'is:unread',offset:40},{query:'is:unread',feedId:f.b.id,offset:10},{query:'is:unread',categoryId:f.category.id},{query:'is:unread after:2026-01-03 before:2026-01-19'},{query:'is:unread feed:"Source A"'}]){
   const anchor=legacy(f.model.db,{...options,limit:5}).at(-1);
   for(const cursor of [undefined,...(anchor?[{sortTime:anchor.published_at||anchor.fetched_at,id:anchor.id}]:[])]){
    const offset=cursor?0:options.offset||0;
    const expected=plain(legacy(f.model.db,{...options,offset,cursor,limit:17,listOnly:true}));
    const params=new URLSearchParams({q:options.query,limit:'17',offset:String(offset)});
    if(options.feedId)params.set('feedId',options.feedId);
    if(options.categoryId)params.set('categoryId',options.categoryId);
    if(cursor){params.set('beforeTime',cursor.sortTime);params.set('beforeId',cursor.id);}
    const response=await service.app.inject({method:'GET',url:'/api/entries?'+params,headers:{'x-rivu-token':'raw-unread-test'}});
    assert.equal(response.statusCode,200);assert.deepEqual(response.json(),expected);
   }
  }
 }finally{await service.stop();f.close();}
});
