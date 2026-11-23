import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,renameSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createService} from '../dist-server/service.js';
import {scanNewsletterFolder,parseNewsletterBatch} from '../dist-server/newsletter.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs'),{writeFeedBatch}=require('../dist-server/feed-write-task.cjs');
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rivu-newsletter-worker-')),folder=join(dir,'mail');mkdirSync(folder);const db=new RivuDatabase(join(dir,'rivu.db')),feed=db.addFeed({title:'邮件',url:pathToFileURL(folder).href,type:'newsletter',folderAuthorized:true});writeFileSync(join(folder,'good.eml'),'Subject: Newsletter\nMessage-ID: <new@example.com>\nContent-Type: text/html; charset=utf-8\n\n<p>星际探索完整正文</p><img src="https://tracker.invalid/x">');writeFileSync(join(folder,'bad.eml'),'');db.db.prepare('INSERT INTO newsletter_files VALUES (?,?,?,?,?)').run(feed.id,'removed.eml',1,1,1);return {dir,folder,db,feed};}
test('Newsletter worker commit includes scan cache cleanup, FTS, rules, success warning and receipt',async()=>{
  const f=fixture(),service=createService(f.db,'token',undefined,f.dir);const request=(method,url,payload)=>service.app.inject({method,url,payload,headers:{'x-rivu-token':'token'}});
  try{
    assert.equal((await service.previewNewsletter(f.folder)).samples.length,1);
    assert.equal((await request('POST','/api/rules',{name:'正文规则',conditions:{bodyKeyword:'星际探索'},action:{type:'save'}})).statusCode,201);
    const result=await request('POST',`/api/feeds/${f.feed.id}/refresh`);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{added:1,total:1});
    const entry=f.db.entries({query:'星际探索'})[0];assert.equal(entry.rule_saved,1);assert.doesNotMatch(entry.content,/tracker|<img/);
    assert.deepEqual(f.db.db.prepare('SELECT file_name,failed FROM newsletter_files ORDER BY file_name').all().map(row=>({...row})),[{file_name:'bad.eml',failed:1},{file_name:'good.eml',failed:0}]);
    assert.equal(f.db.feed(f.feed.id).failure_count,0);assert.match(f.db.feed(f.feed.id).last_error,/1 个/);assert.ok(f.db.feed(f.feed.id).last_success_at);
    assert.ok(f.db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(`feed-write:${f.feed.id}`));
    await request('PATCH',`/api/entries/${entry.id}`,{read:true,starred:true});assert.equal((await request('POST',`/api/feeds/${f.feed.id}/refresh`)).json().added,0);assert.equal(f.db.entry(entry.id).read,1);assert.equal(f.db.entry(entry.id).starred,1);
  }finally{await service.stop();f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Newsletter rejects a redirected authorized directory before parsing or changing scan state',async()=>{
  const f=fixture();
  try{let input;await scanNewsletterFolder(f.db,f.feed.id,parseNewsletterBatch,async value=>{input=value;return {added:0,total:value.items.length};});renameSync(f.folder,join(f.dir,'original'));const replacement=join(f.dir,'replacement');mkdirSync(replacement);writeFileSync(join(replacement,'secret.eml'),'Subject: Secret\n\nPrivate');symlinkSync(replacement,f.folder,process.platform==='win32'?'junction':'dir');let parsed=false;
    assert.throws(()=>writeFeedBatch(input),/路径已变更/);
    await assert.rejects(scanNewsletterFolder(f.db,f.feed.id,async()=>{parsed=true;return [];},writeFeedBatch),/路径已变更/);assert.equal(parsed,false);assert.equal(f.db.entries().length,0);assert.equal(f.db.db.prepare('SELECT count(*) n FROM newsletter_files').get().n,1);
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Newsletter bounds accumulated normalized output and leaves deferred files unremembered',async()=>{
  const f=fixture();
  try{for(let i=0;i<8;i++)writeFileSync(join(f.folder,`large-${i}.eml`),'Subject: Mock\n\nBody');let input;const content='x'.repeat(5_000_000);
    await scanNewsletterFolder(f.db,f.feed.id,async messages=>messages.map(({name})=>({name,entry:{title:name,guid:name,hash:name,sender:'',content}})),async value=>{input=value;return {added:value.items.length,total:value.items.length};});
    assert.equal(input.items.length,6);assert.ok(input.items.reduce((bytes,entry)=>bytes+JSON.stringify(entry).length*2,0)<=64*1024*1024);assert.equal(input.newsletter.records.length,6);assert.equal(f.db.db.prepare('SELECT count(*) n FROM newsletter_files').get().n,1);
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Newsletter audit cursor stops at the last committed result when normalized budget drops later audit mail',async()=>{
  const f=fixture();
  try{rmSync(join(f.folder,'bad.eml'));rmSync(join(f.folder,'good.eml'));for(let i=0;i<8;i++){const file=`audit-${i}.eml`;writeFileSync(join(f.folder,file),'Subject: Mock\n\nBody');const info=statSync(join(f.folder,file));f.db.db.prepare('INSERT INTO newsletter_files VALUES (?,?,?,?,0)').run(f.feed.id,file,Math.trunc(info.mtimeMs),info.size);}let input;const content='x'.repeat(5_000_000);
    await scanNewsletterFolder(f.db,f.feed.id,async messages=>messages.map(({name})=>({name,entry:{title:name,guid:name,hash:name,sender:'',content}})),async value=>{input=value;return {added:0,total:value.items.length};});
    assert.equal(input.items.length,6);assert.equal(input.newsletter.lastAudited,'audit-5.eml');assert.deepEqual(input.newsletter.records.map(record=>record.file),Array.from({length:6},(_,i)=>`audit-${i}.eml`));
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Newsletter keeps a 500-message refresh while limiting each parser job to 20 messages',async()=>{
  const f=fixture();
  try{for(let i=0;i<500;i++)writeFileSync(join(f.folder,`${String(i).padStart(3,'0')}.eml`),'Subject: Mock\n\nBody');const batches=[];let input;
    await scanNewsletterFolder(f.db,f.feed.id,async messages=>{batches.push(messages.length);assert.ok(messages.length<=20);return messages.map(({name})=>({name,entry:{title:name,guid:name,hash:name,sender:'',content:'Body'}}));},async value=>{input=value;return {added:value.items.length,total:value.items.length};});
    assert.equal(input.items.length,500);assert.equal(batches.length,25);assert.equal(Math.max(...batches),20);assert.equal(input.newsletter.records.length,500);
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Newsletter stale authorization, parser failure and transaction failure leave scan records and articles unchanged',async()=>{
  const f=fixture();
  try{
    const before=()=>f.db.db.prepare('SELECT * FROM newsletter_files').all().map(row=>({...row})),original=before();
    await assert.rejects(scanNewsletterFolder(f.db,f.feed.id,async()=>{throw Object.assign(Error('busy'),{resourceBusy:true});},writeFeedBatch),/busy/);assert.deepEqual(before(),original);assert.equal(f.db.entries().length,0);
    f.db.db.exec("CREATE TRIGGER reject_cache BEFORE INSERT ON newsletter_files BEGIN SELECT RAISE(ABORT,'cache failure'); END");
    await assert.rejects(scanNewsletterFolder(f.db,f.feed.id,parseNewsletterBatch,writeFeedBatch),/cache failure/);assert.deepEqual(before(),original);assert.equal(f.db.entries().length,0);assert.equal(f.db.feed(f.feed.id).last_success_at,null);assert.equal(f.db.entries({query:'星际探索'}).length,0);
    f.db.db.exec('DROP TRIGGER reject_cache');
    await assert.rejects(scanNewsletterFolder(f.db,f.feed.id,async messages=>{const parsed=await parseNewsletterBatch(messages);f.db.db.prepare('UPDATE feeds SET folder_authorized=0 WHERE id=?').run(f.feed.id);return parsed;},writeFeedBatch),/变更/);assert.deepEqual(before(),original);assert.equal(f.db.entries().length,0);
  }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true});}
});
