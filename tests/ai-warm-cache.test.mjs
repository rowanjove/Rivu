import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {RivuDatabase} from '../dist-server/database.cjs';
import {AIService} from '../dist-server/ai.js';
import {FeedParser} from '../dist-server/feed-parser.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-warm-')),db=new RivuDatabase(join(dir,'rivu.db')),feed=db.addFeed({title:'Local',url:'https://example.invalid/feed'});db.addEntries(feed.id,[{title:'Title',content:'<p>Body</p>',hash:'one'}]);return {dir,db,feed,id:db.entries()[0].id,close(){db.close();rmSync(dir,{recursive:true,force:true});}};}
const hash=html=>createHash('sha256').update(html).digest('hex');
test('worker digest matches UTF8 SHA256 and shares parser input admission',async()=>{
  const parser=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'));
  try{for(const html of ['', '<p>中文😀\u0000</p>', 'x'.repeat(1000000)])assert.equal(await parser.aiDigest(html),hash(html));assert.equal(await parser.aiText('<p>Body</p>'),'Body');}
  finally{await parser.stop();}
  const small=new FeedParser(resolve('dist-server/feed-parse-worker.cjs'),undefined,64,32);
  try{await assert.rejects(small.aiDigest('x'.repeat(20)),error=>error.statusCode===503&&error.resourceBusy);assert.equal(await small.aiDigest('a'),hash('a'));}finally{await small.stop();}
});
test('warm revision aliases avoid HTML reads and hashing while retaining metadata and content deduplication',async()=>{
  const f=fixture();let snapshots=0,hashes=0,parses=0;const snapshot=f.db.aiBodySnapshot.bind(f.db);f.db.aiBodySnapshot=id=>{snapshots++;return snapshot(id);};
  const ai=new AIService(f.db,undefined,undefined,async()=>{parses++;return 'Body';},undefined,async html=>{hashes++;return hash(html);});
  try{const preview=()=>ai.withPreparedBodies([f.id],()=>ai.previewAction(f.id,'summary'));const first=await preview();for(let i=0;i<5;i++)assert.deepEqual(await preview(),first);assert.deepEqual([snapshots,hashes,parses],[1,1,1]);
    f.db.updateEntry(f.id,{read:true,starred:true});await preview();assert.deepEqual([snapshots,hashes,parses],[1,1,1]);
    f.db.db.prepare('UPDATE entries SET title=? WHERE id=?').run('New title',f.id);assert.equal((await preview()).title,'New title');assert.deepEqual([snapshots,hashes,parses],[2,2,1]);
    f.db.setFullContent(f.id,'<p>Other</p>');await preview();assert.deepEqual([snapshots,hashes,parses],[3,3,2]);
    f.db.db.prepare('DELETE FROM entries WHERE id=?').run(f.id);await assert.rejects(preview(),error=>error.statusCode===404);
    f.db.db.prepare('INSERT INTO entries(id,feed_id,title,content,hash,fetched_at) VALUES (?,?,?,?,?,?)').run(f.id,f.feed.id,'Title','<p>Body</p>','one','2026-01-01');await preview();assert.deepEqual([snapshots,hashes,parses],[5,4,2]);
    assert.ok(ai.cacheBytes<=16*1024*1024);assert.ok(ai.bodyAliases.size<=256);
  }finally{f.close();}
});
test('mutation and settings changes during worker hashing reject before parse or action',async t=>{
  for(const change of ['body','settings'])await t.test(change,async()=>{const f=fixture();let release,started,parses=0,acted=false;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);const ai=new AIService(f.db,undefined,undefined,async()=>{parses++;return 'Body';},undefined,async html=>{started();await gate;return hash(html);});
    try{const pending=ai.withPreparedBodies([f.id],()=>{acted=true;return ai.previewAction(f.id,'summary');});await ready;if(change==='body')f.db.setFullContent(f.id,'Changed');else ai.configure({model:'changed'});release();await assert.rejects(pending,error=>error.statusCode===409);assert.equal(acted,false);if(change==='body')assert.equal(parses,0);assert.equal(ai.retainedBytes,0);}
    finally{release();f.close();}
  });
});
test('invalid or failed hashes do not poison cache and retained input is released',async()=>{
  const f=fixture();let attempt=0,parses=0;const ai=new AIService(f.db,undefined,undefined,async()=>{parses++;return 'Body';},undefined,async html=>{attempt++;if(attempt===1)throw Error('hash failed');return attempt===2?'bad':hash(html);});
  try{const preview=()=>ai.withPreparedBodies([f.id],()=>ai.previewAction(f.id,'summary'));await assert.rejects(preview(),/hash failed/);await assert.rejects(preview(),error=>error.statusCode===503);assert.equal(parses,0);assert.equal(ai.retainedBytes,0);assert.equal(ai.cacheBytes,0);await preview();assert.equal(parses,1);assert.ok(ai.cacheBytes>0);}
  finally{f.close();}
});
test('body eviction removes aliases and accounts all cached bodies and alias metadata',async()=>{
  const f=fixture();let reads=0;const snapshot=f.db.aiBodySnapshot.bind(f.db);f.db.aiBodySnapshot=id=>{reads++;return snapshot(id);};
  const ai=new AIService(f.db,undefined,undefined,async html=>html,undefined,async html=>hash(html));
  try{f.db.setFullContent(f.id,'a'.repeat(2500000));await ai.withPreparedBodies([f.id],()=>{});f.db.addEntries(f.feed.id,[{title:'Second',content:'b'.repeat(2500000),hash:'two'}]);const second=f.db.entries().find(e=>e.title==='Second').id;await ai.withPreparedBodies([second],()=>{});assert.ok(ai.cacheBytes<=16*1024*1024);assert.equal(ai.bodyAliases.has(f.id),false);const before=reads;await ai.withPreparedBodies([f.id],()=>{});assert.equal(reads,before+1);assert.equal(ai.bodyAliases.has(second),false);assert.ok(ai.cacheBytes<=16*1024*1024);}
  finally{f.close();}
});
