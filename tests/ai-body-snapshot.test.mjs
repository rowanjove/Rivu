import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';
import {AIService} from '../dist-server/ai.js';
import {AIScanner} from '../dist-server/ai-scanner.js';
import {readAIBodies,AI_BODY_SIZE_SQL} from '../dist-server/ai-scan-task.cjs';
import {FeedParser} from '../dist-server/feed-parser.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-ai-snapshot-')),path=join(dir,'rivu.db'),db=new RivuDatabase(path),feed=db.addFeed({title:'Local',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'First',content:'<p>First body</p>',hash:'one'},{title:'Second',content:'<p>Second body</p>',hash:'two'}]);const ids=db.entries().map(e=>e.id),scanner=new AIScanner(resolve('dist-server/ai-scan-worker.cjs'));return {dir,path,db,feed,ids,scanner,async close(){await scanner.stop();db.close();rmSync(dir,{recursive:true,force:true});}};}
const input=(f,entryIds=f.ids,maxBytes=64*1024*1024)=>({operation:'bodies',databasePath:f.path,entryIds,maxBytes});
test('size preflight keeps direct octet-length column reads and rejects before selecting HTML',async()=>{
  const f=fixture();try{
    const columns=f.db.db.prepare('PRAGMA table_info(entries)').all(),flags=sql=>f.db.db.prepare('EXPLAIN '+sql).all(f.ids[0]).filter(row=>row.opcode==='Column');
    const reference=flags('SELECT octet_length(title),octet_length(full_content),octet_length(content),octet_length(description) FROM entries WHERE id=?'),actual=flags(AI_BODY_SIZE_SQL);
    for(const name of ['title','full_content','content','description']){const index=columns.find(row=>row.name===name).cid,expected=reference.filter(row=>row.p2===index);assert.ok(expected.length);assert.deepEqual(actual.filter(row=>row.p2===index).map(row=>row.p5),expected.map(row=>row.p5));assert.ok(expected.every(row=>row.p5!==0));}
    const prepare=DatabaseSync.prototype.prepare;let bodyReads=0;
    DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql.includes(' html,body_revision FROM entries WHERE id=?')){const get=statement.get;statement.get=function(...args){bodyReads++;return get.apply(this,args);};}return statement;};
    try{assert.throws(()=>readAIBodies(input(f,[f.ids[0]],0)),error=>error.statusCode===503&&error.resourceBusy);assert.equal(bodyReads,0);}finally{DatabaseSync.prototype.prepare=prepare;}
    await assert.rejects(f.scanner.readBodies(input(f,[f.ids[0]],0)),error=>error.statusCode===503&&error.resourceBusy);
  }finally{await f.close();}
});
test('snapshot body reader pins one read-only transaction, preserves order, duplicates and field precedence',async()=>{
  const f=fixture();try{const id=f.ids[0];f.db.db.prepare('UPDATE entries SET content=?,description=?,full_content=? WHERE id=?').run('', '中文😀\0 tail', '',id);const before=f.db.aiBodySnapshot(id);const snapshot=readAIBodies(input(f,[id,f.ids[1],id]),()=>f.db.setFullContent(id,'Changed after pin'));
    assert.deepEqual(snapshot.rows.map(row=>row.id),[id,f.ids[1]]);assert.deepEqual({...snapshot.rows[0]},{...before});assert.equal(snapshot.bytes,snapshot.rows.reduce((n,row)=>n+256+2*(row.html.length+row.title.length),0));assert.notEqual(snapshot.rows[0].body_revision,f.db.aiBodyIdentity(id).body_revision);
    const current=await f.scanner.readBodies(input(f,[id]));assert.equal(current.rows[0].html,'Changed after pin');assert.equal(current.rows[0].body_revision,f.db.aiBodyIdentity(id).body_revision);
  }finally{await f.close();}
});
test('snapshot body input and exact byte budgets reject before publishing partial rows',async()=>{
  const f=fixture();try{const full=await f.scanner.readBodies(input(f));await assert.rejects(f.scanner.readBodies(input(f,f.ids,full.bytes-1)),error=>error.statusCode===503&&error.resourceBusy);assert.deepEqual(await f.scanner.readBodies(input(f,f.ids,full.bytes)),full);
    await assert.rejects(f.scanner.readBodies(input(f,['missing'])),error=>error.statusCode===404);for(const patch of [{entryIds:[]},{entryIds:Array(21).fill(f.ids[0])},{entryIds:[null]},{maxBytes:-1},{maxBytes:64*1024*1024+1}])await assert.rejects(f.scanner.readBodies({...input(f),...patch}),error=>error.statusCode===400);
  }finally{await f.close();}
});
test('background prepared scopes forbid main HTML reads, preserve cold/warm citation order and worker parsing',async()=>{
  const f=fixture(),parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));let reads=0;f.db.aiBodySnapshot=()=>{throw Error('main body read forbidden');};const ai=new AIService(f.db,undefined,undefined,html=>parser.aiText(html),undefined,html=>parser.aiDigest(html),async value=>{reads++;return f.scanner.readBodies(value);});
  try{await ai.withPreparedBodies([f.ids[1]],()=>ai.preview([f.ids[1]]));const preview=await ai.withPreparedBodies(f.ids,()=>ai.preview(f.ids));assert.deepEqual(preview.sources.map(source=>source.entryId),f.ids);assert.equal(reads,2);await ai.withPreparedBodies(f.ids,()=>ai.preview(f.ids));assert.equal(reads,2);assert.equal(ai.retainedBytes,0);assert.ok(ai.cacheBytes<=16*1024*1024);}
  finally{await parser.stop();await f.close();}
});
test('body mutation after snapshot or settings change while snapshot waits cannot invoke the action',async t=>{
  for(const kind of ['body','settings','delete'])await t.test(kind,async()=>{const f=fixture();let acted=false;const ai=new AIService(f.db,undefined,undefined,async()=> 'Body',undefined,undefined,async value=>{const result=await f.scanner.readBodies(value);if(kind==='body')f.db.setFullContent(f.ids[0],'Changed');else if(kind==='delete')f.db.db.prepare('DELETE FROM entries WHERE id=?').run(f.ids[0]);else ai.configure({model:'Changed'});return result;});
    try{await assert.rejects(ai.withPreparedBodies([f.ids[0]],()=>{acted=true;}),error=>error.statusCode===(kind==='delete'?404:409));assert.equal(acted,false);assert.equal(ai.retainedBytes,0);}finally{await f.close();}
  });
});
test('invalid body responses bind IDs, revisions, order and exact accounting',async t=>{
  for(const kind of ['id','revision','bytes','order','missing'])await t.test(kind,async()=>{const f=fixture();let acted=false,parses=0;const ai=new AIService(f.db,undefined,undefined,async()=>{parses++;return 'Body';},undefined,undefined,async value=>{const result=await f.scanner.readBodies(value);if(kind==='id')result.rows[0].id='wrong';if(kind==='revision')result.rows[0].body_revision='invalid';if(kind==='bytes')result.bytes++;if(kind==='order')result.rows.reverse();if(kind==='missing')result.rows.pop();return result;});try{await assert.rejects(ai.withPreparedBodies(f.ids,()=>{acted=true;}),error=>error.statusCode===503);assert.equal(acted,false);assert.equal(parses,0);assert.equal(ai.retainedBytes,0);}finally{await f.close();}});
});
test('concurrent returned snapshots reserve input before main resumption and reject combined overflow',async()=>{
  const html='x'.repeat(20*1024*1024),revision='a'.repeat(32);let releaseRead,releaseParse,started,readCalls=0;const readGate=new Promise(resolve=>releaseRead=resolve),parseGate=new Promise(resolve=>releaseParse=resolve),ready=new Promise(resolve=>started=resolve);let acted=0;
  const ai=new AIService({path:'unused',aiBodyIdentity:id=>({id,title:id,body_revision:revision})},undefined,undefined,async()=>{started();await parseGate;return 'Body';},undefined,async()=> 'b'.repeat(64),async value=>{readCalls++;await readGate;const row={id:value.entryIds[0],title:value.entryIds[0],html,body_revision:revision};return {rows:[row],bytes:256+2*(html.length+row.title.length)};});
  const first=ai.withPreparedBodies(['one'],()=>{acted++;}),second=ai.withPreparedBodies(['two'],()=>{acted++;});const denied=assert.rejects(second,error=>error.statusCode===503&&error.resourceBusy);try{assert.equal(readCalls,2);releaseRead();await ready;await denied;assert.ok(ai.retainedBytes>40*1024*1024&&ai.retainedBytes<=64*1024*1024);releaseParse();await first;assert.equal(acted,1);assert.equal(ai.retainedBytes,0);}finally{releaseRead();releaseParse();await Promise.allSettled([first,second]);}
});
