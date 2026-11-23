import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {RivuDatabase} from '../dist-server/database.cjs';
import {EntryReader} from '../dist-server/entry-reader.js';
import {createService} from '../dist-server/service.js';
const require=createRequire(import.meta.url),{readEntrySnapshot}=require('../dist-server/entry-read-task.cjs');
const worker=resolve('dist-server/entry-read-worker.cjs'),task=resolve('dist-server/entry-read-task.cjs');
const clean=value=>JSON.parse(JSON.stringify(value));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+10000;while(!check()){assert.ok(Date.now()<end,'snapshot barrier timeout');await delay(10);}}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('independent read or commit blocked')),10000))]);}finally{clearTimeout(timer);}}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'rivu-entry-detail-')),db=new RivuDatabase(join(directory,'rivu.db'));
  const feed=db.addFeed({title:'Local',url:'https://example.invalid/local',siteUrl:'https://example.invalid/',fetchInterval:0});
  db.addEntries(feed.id,[{title:'Full detail',content:'<p>'+('中文😀'.repeat(50000))+'</p>',description:'Description',author:'Author',hash:'entry'}]);
  return {directory,db,feed,id:db.entries()[0].id,close(){db.close();const path=relative(resolve(tmpdir()),resolve(directory));assert.ok(path.startsWith('rivu-entry-detail-')&&!path.startsWith('..')&&!isAbsolute(path));rmSync(directory,{recursive:true,force:true});}};
}

test('single-entry snapshot retains the legacy full SQL shape, rules, AI visibility and missing membership',()=>{
  const f=fixture();try{
    f.db.updateEntry(f.id,{read:true,starred:true,saved:true,archived:true});
    f.db.db.prepare("UPDATE entries SET full_content=?,full_content_fetched_at=? WHERE id=?").run('<p>Full cached text</p>','2026-10-07',f.id);
    f.db.setFilterDecision(f.id,{decision:'block',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'entry'});
    for(const action of ['save','mute']){
      f.db.db.prepare('INSERT INTO rules(id,name,priority,enabled,conditions,action_type,tag_id,created_at,updated_at) VALUES (?,?,0,1,?,?,NULL,?,?)').run(action,action,'{}',action,'2026','2026');
      f.db.db.prepare('INSERT INTO rule_matches VALUES (?,?,?)').run(action,f.id,'2026');
    }
    // This reference intentionally keeps the original projection independent of queryEntry.
    const fields=['id','feed_id','guid','title','author','url','published_at','fetched_at','content','description','cover','language','read','starred','archived','saved','hash','full_content','full_content_fetched_at','body_revision'].map(c=>`${['content','description','full_content'].includes(c)?'e':'m'}.${c}`).join(',');
    const rule=type=>`EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='${type}')`;
    const expected=f.db.db.prepare(`SELECT ${fields},f.title feed_title,f.site_url feed_site_url,f.url feed_url,f.allow_private feed_allow_private,CASE WHEN ${rule('save')} THEN 1 ELSE 0 END rule_saved,CASE WHEN (${rule('mute')} OR COALESCE(e.id IN (SELECT entry_id FROM ai_filter_decisions WHERE decision='mute' AND entry_id IS NOT NULL),0)) THEN 1 ELSE 0 END rule_muted,CASE WHEN (${rule('block')} OR COALESCE(e.id IN (SELECT entry_id FROM ai_filter_decisions WHERE decision='block' AND entry_id IS NOT NULL),0)) THEN 1 ELSE 0 END rule_blocked FROM entries e JOIN entries m INDEXED BY entries_list_metadata ON m.id=e.id JOIN feeds f ON f.id=m.feed_id WHERE e.id=?`).get(f.id);
    assert.equal(expected.rule_blocked,1);assert.equal(expected.rule_saved,1);assert.equal(expected.rule_muted,1);
    assert.deepEqual(clean(readEntrySnapshot({databasePath:f.db.path,kind:'entry',entryId:f.id})),clean(expected));
    assert.equal(readEntrySnapshot({databasePath:f.db.path,kind:'entry',entryId:'missing'}),undefined);
    f.db.db.exec('PRAGMA foreign_keys=OFF');f.db.db.prepare("UPDATE entries SET feed_id='orphan' WHERE id=?").run(f.id);
    assert.equal(readEntrySnapshot({databasePath:f.db.path,kind:'entry',entryId:f.id}),undefined);
  }finally{f.close();}
});

test('single-entry WAL snapshot stays coherent across body, source and visibility commits',async()=>{
  const f=fixture(),gate=new SharedArrayBuffer(8),flags=new Int32Array(gate),custom=join(f.directory,'snapshot.cjs');
  writeFileSync(custom,`const {readEntrySnapshot}=require(${JSON.stringify(task)});exports.readEntrySnapshot=input=>readEntrySnapshot(input,()=>{const flags=new Int32Array(input.gate);Atomics.store(flags,0,1);Atomics.wait(flags,1,0);});`);
  const reader=new EntryReader(worker,custom),expected=clean(f.db.entry(f.id));let pending;
  try{
    pending=reader.read({databasePath:f.db.path,kind:'entry',entryId:f.id,gate});await until(()=>Atomics.load(flags,0)===1);
    f.db.db.prepare('UPDATE entries SET content=? WHERE id=?').run('<p>New body</p>',f.id);f.db.updateFeed(f.feed.id,{title:'New source'});
    f.db.setFilterDecision(f.id,{decision:'mute',reason:'fixture',criteria:'fixture',provider:'local',model:'fixture',content_hash:'entry'});
    Atomics.store(flags,1,1);Atomics.notify(flags,1);assert.deepEqual(await pending,expected);
    const fresh=readEntrySnapshot({databasePath:f.db.path,kind:'entry',entryId:f.id});assert.equal(fresh.content,'<p>New body</p>');assert.equal(fresh.feed_title,'New source');assert.equal(fresh.rule_muted,1);
  }finally{Atomics.store(flags,1,1);Atomics.notify(flags,1);await pending?.catch(()=>{});await reader.stop();f.close();}
});

test('single-entry API never uses the main full reader and retains 404 and auth',async()=>{
  const f=fixture(),expected=clean(f.db.entry(f.id)),service=createService(f.db,'token');
  try{
    f.db.entry=()=>{throw Error('main full reader forbidden');};
    const request=url=>service.app.inject({url,headers:{'x-rivu-token':'token'}});
    const response=await request(`/api/entries/${f.id}`);assert.equal(response.statusCode,200);assert.deepEqual(response.json(),expected);
    assert.equal((await request('/api/entries/missing')).statusCode,404);
    assert.equal((await service.app.inject({url:`/api/entries/${f.id}`})).statusCode,401);
  }finally{await service.stop();f.close();}
});

for(const heldKinds of [['feed_metadata','entries'],['entry']])test(`independent read lanes and Feed commits survive held ${heldKinds.join('+')} snapshots; stop drains`,async()=>{
  const f=fixture(),custom=join(f.directory,'held.cjs');
  writeFileSync(custom,`const fs=require('node:fs');const {readEntrySnapshot}=require(${JSON.stringify(task)});exports.readEntrySnapshot=input=>readEntrySnapshot(input,()=>{if(${JSON.stringify(heldKinds)}.includes(input.kind)){fs.writeFileSync(${JSON.stringify(f.directory)}+'/'+input.kind+'.ready','ready');while(!fs.existsSync(${JSON.stringify(join(f.directory,'release'))}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}});`);
  const origin=createServer((_req,res)=>{res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>Fixture</title>'+Array.from({length:80},(_,i)=>`<item><guid>new-${i}</guid><title>Fresh ${i}</title><description>fixture</description></item>`).join('')+'</channel></rss>');});
  await new Promise(r=>origin.listen(0,'127.0.0.1',r));
  const remote=f.db.addFeed({title:'Fixture',url:`http://127.0.0.1:${origin.address().port}/feed`,allowPrivate:true,fetchInterval:0});
  const service=createService(f.db,'token',...Array(14).fill(undefined),worker,custom),request=(method,url)=>service.app.inject({method,url,headers:{'x-rivu-token':'token'}});
  const paths={entry:`/api/entries/${f.id}`,entries:'/api/entries?limit=1',feed_metadata:'/api/feeds?icons=metadata'};
  const held=[],flood=[];let stopping;
  try{
    for(const kind of heldKinds)held.push(request('GET',paths[kind]));
    await until(()=>heldKinds.every(kind=>existsSync(join(f.directory,kind+'.ready'))));
    if(heldKinds.includes('feed_metadata')){
      let rejected=0;
      for(let i=0;i<20;i++)flood.push(request('GET',paths.feed_metadata).then(response=>{if(response.statusCode===503)rejected++;return response;}));
      await until(()=>rejected===4);
    }
    for(const kind of Object.keys(paths).filter(kind=>!heldKinds.includes(kind)))assert.equal((await bounded(request('GET',paths[kind]))).statusCode,200);
    const refresh=await bounded(request('POST',`/api/feeds/${remote.id}/refresh`));assert.equal(refresh.statusCode,200,refresh.body);assert.equal(refresh.json().added,80);
    assert.equal((await bounded(request('GET','/health'))).statusCode,200);
    let drained=false;stopping=service.stop().then(()=>{drained=true;});await delay(30);assert.equal(drained,false);
    assert.equal((await request('GET',paths.entry)).statusCode,503);
    writeFileSync(join(f.directory,'release'),'release');for(const response of await Promise.all(held))assert.equal(response.statusCode,200);
    if(flood.length){const results=await Promise.all(flood);assert.equal(results.filter(response=>response.statusCode===200).length,16);assert.equal(results.filter(response=>response.statusCode===503).length,4);}
    await bounded(stopping);
  }finally{writeFileSync(join(f.directory,'release'),'release');await Promise.allSettled([...held,...flood]);await (stopping||service.stop());await new Promise(r=>origin.close(r));f.close();}
});
