import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {createService} from '../dist-server/service.js';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'rivu-mutation-meta-')),db=new RivuDatabase(join(directory,'rivu.db'));
  const feed=db.addFeed({title:'Fixture',url:'https://example.invalid/feed',fetchInterval:0});
  db.addEntries(feed.id,[{title:'Large body',content:'<p>'+('正文'.repeat(100000))+'</p>',hash:'entry'}]);
  return {db,feed,id:db.entries()[0].id,close(){db.close();const path=relative(resolve(tmpdir()),resolve(directory));assert.ok(path.startsWith('rivu-mutation-meta-')&&!path.startsWith('..')&&!isAbsolute(path));rmSync(directory,{recursive:true,force:true});}};
}

test('state updates read only metadata before returning the unchanged complete article shape',()=>{
  const f=fixture();try{
    const original=f.db.entry.bind(f.db),before=original(f.id);let bodyReads=0;
    f.db.entry=id=>{bodyReads++;return original(id);};
    const state=f.db.entryState(f.id);
    assert.deepEqual({...state},{id:f.id,feed_id:f.feed.id,read:0,starred:0,saved:0,archived:0});
    const plan=f.db.db.prepare('EXPLAIN QUERY PLAN SELECT e.id,e.feed_id,e.read,e.starred,e.saved,e.archived FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=? LIMIT 1').all(f.id);
    assert.ok(plan.some(row=>/COVERING INDEX entries_list_metadata/.test(row.detail)));
    for(const patch of [{read:true,starred:true,saved:true,archived:true},{read:false},{saved:false,archived:false},{}]){
      const expected={...before,...f.db.entryState(f.id),...Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,Number(v)]))};
      const count=bodyReads,result=f.db.updateEntry(f.id,patch);
      assert.equal(bodyReads,count+1);assert.deepEqual({...result},expected);
    }
    const count=bodyReads;assert.equal(f.db.updateEntry('missing',{read:true}),undefined);assert.equal(bodyReads,count);
  }finally{f.close();}
});

test('local metadata mutations avoid body loads and preserve rollback, filtering and source membership',()=>{
  const f=fixture();try{
    f.db.entry=()=>{throw Error('body lookup forbidden');};
    for(const status of ['running','ready','partial','failed','interrupted'])assert.equal(f.db.setOfflineSave(f.id,true,status,'fixture').status,status);
    const first=f.db.addTag('First'),second=f.db.addTag('Second');
    assert.equal(f.db.setEntryTags(f.id,[first.id,first.id]).length,1);
    assert.throws(()=>f.db.setEntryTags(f.id,[second.id,'missing-tag']));
    assert.deepEqual(f.db.entryTags(f.id).map(t=>t.id),[first.id]);
    assert.throws(()=>f.db.appendEntryTagNames(f.id,['Rolled back'],()=>{throw Error('reconcile failed');}),/reconcile failed/);
    assert.ok(!f.db.tags().some(t=>t.name==='Rolled back'));
    let reconciled;f.db.appendEntryTagNames(f.id,['Second'],feed=>{reconciled=feed;});assert.equal(reconciled,f.feed.id);
    assert.equal(f.db.entryTags(f.id).length,2);
    const decision={decision:'mute',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'fixture'};
    assert.equal(f.db.setFilterDecision(f.id,decision).decision,'mute');
    assert.equal(f.db.setFilterDecision(f.id,{...decision,decision:'keep'}),null);
    f.db.db.exec('PRAGMA foreign_keys=OFF');f.db.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(f.id);
    for(const id of [f.id,'missing']){
      assert.equal(f.db.entryState(id),undefined);assert.equal(f.db.setOfflineSave(id,false,'ready'),undefined);
      assert.equal(f.db.setEntryTags(id,[]),undefined);
      assert.throws(()=>f.db.setFilterDecision(id,decision),error=>error.statusCode===404);
      assert.throws(()=>f.db.appendEntryTagNames(id,[],()=>{}),error=>error.statusCode===404);
    }
  }finally{f.close();}
});

test('manual tag API reconciles rules without a full article preflight and preserves request errors',async()=>{
  const f=fixture(),service=createService(f.db,'token'),request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
  try{
    const tag=f.db.addTag('Manual');
    assert.equal((await request('POST','/api/rules',{name:'Save tagged',conditions:{tagId:tag.id},action:{type:'save'}})).statusCode,201);
    f.db.entry=()=>{throw Error('body lookup forbidden');};
    const response=await request('PATCH',`/api/entries/${f.id}/tags`,{tagIds:[tag.id]});
    assert.equal(response.statusCode,200);assert.equal(response.json()[0].id,tag.id);
    assert.ok(f.db.db.prepare("SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=? AND r.action_type='save'").get(f.id));
    assert.equal((await request('PATCH',`/api/entries/${f.id}/tags`,{tagIds:[]})).statusCode,200);
    assert.equal(f.db.db.prepare('SELECT count(*) count FROM rule_matches WHERE entry_id=?').get(f.id).count,0);
    assert.equal((await request('PATCH','/api/entries/missing/tags',{tagIds:[]})).statusCode,404);
    assert.equal((await request('PATCH',`/api/entries/${f.id}/tags`,{tagIds:'bad'})).statusCode,400);
    assert.equal((await service.app.inject({method:'PATCH',url:`/api/entries/${f.id}/tags`,payload:{tagIds:[]}})).statusCode,401);
  }finally{await service.stop();f.close();}
});
