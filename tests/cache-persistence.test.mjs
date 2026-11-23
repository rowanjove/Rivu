import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:http';
import {ImageCache} from '../dist-server/image-cache.js';
import {RivuDatabase} from '../dist-server/database.cjs';
const fs=createRequire(import.meta.url)('node:fs'),GIB=1024**3;
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-cache-persist-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-cache-persist-')&&!scope.startsWith('..')&&!isAbsolute(scope));const db=new RivuDatabase(join(directory,'rivu.db')),file=join(directory,'settings.json'),initial={theme:'dark',extra:{keep:true},imageCache:{enabled:false,maxBytes:10*GIB}};writeFileSync(file,JSON.stringify(initial));return {directory,db,file,initial,cache:new ImageCache(db,file,directory),close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
for(const phase of ['write','rename'])test(`cache ${phase} failure preserves memory, disk and unrelated settings, cleaning its staged file`,async()=>{
 const f=fixture(),before=readFileSync(f.file);
 try{
  if(phase==='rename'){const original=fs.renameSync;mock.method(fs,'renameSync',(source,destination)=>{if(destination===f.file)throw Error('fixture rename failure');return original(source,destination);});}
  else{const original=fs.writeFileSync;mock.method(fs,'writeFileSync',(path,...args)=>{if(typeof path==='number'){original(path,'partial staging');throw Error('fixture write failure');}return original(path,...args);});}
  syncBuiltinESMExports();await assert.rejects(f.cache.configure({enabled:true,maxBytes:GIB}),/fixture/);assert.deepEqual(f.cache.getSettings(),f.initial.imageCache);assert.deepEqual(readFileSync(f.file),before);assert.equal(readdirSync(f.directory).some(name=>name.startsWith('settings.json.')&&name.endsWith('.tmp')),false);
  mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(new ImageCache(f.db,f.file,f.directory).getSettings(),f.initial.imageCache);await f.cache.configure({enabled:true});assert.deepEqual(JSON.parse(readFileSync(f.file)),{...f.initial,imageCache:{...f.initial.imageCache,enabled:true}});
 }finally{mock.restoreAll();syncBuiltinESMExports();f.close();}
});
test('unreadable or malformed existing settings and invalid payloads are never overwritten',async()=>{
 const f=fixture();try{
  for(const raw of ['{broken','null','[]']){writeFileSync(f.file,raw);await assert.rejects(f.cache.configure({enabled:true}),/无法读取现有设置/);assert.equal(readFileSync(f.file,'utf8'),raw);assert.deepEqual(f.cache.getSettings(),f.initial.imageCache);}
  writeFileSync(f.file,JSON.stringify(f.initial));const original=fs.readFileSync;mock.method(fs,'readFileSync',(path,...args)=>{if(path===f.file)throw Object.assign(Error('fixture access denied'),{code:'EACCES'});return original(path,...args);});syncBuiltinESMExports();await assert.rejects(f.cache.configure({enabled:true}),/无法读取现有设置/);mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(JSON.parse(readFileSync(f.file)),f.initial);
  for(const payload of [null,[],{other:1},{enabled:'yes'},{maxBytes:-1},{maxBytes:3*GIB}])await assert.rejects(f.cache.configure(payload),error=>error.statusCode===400);assert.deepEqual(f.cache.getSettings(),f.initial.imageCache);
  const snapshot=f.cache.getSettings();snapshot.enabled=true;assert.equal(f.cache.getSettings().enabled,false);
 }finally{mock.restoreAll();syncBuiltinESMExports();f.close();}
});
test('missing settings are created without confusing absence with a read failure',async()=>{
 const f=fixture();try{rmSync(f.file);await f.cache.configure({enabled:true});assert.deepEqual(new ImageCache(f.db,f.file,f.directory).getSettings(),{...f.initial.imageCache,enabled:true});}finally{f.close();}
});
test('real unlink failure retains committed quota and cache metadata, survives restart and retries without touching articles or archives',async()=>{
 const f=fixture(),name='a'.repeat(64)+'.png',target=join(f.directory,'cache','images',name);assert.ok(relative(f.directory,target).startsWith('cache'));
 try{
  const feed=f.db.addFeed({title:'Preserved',url:'https://fixture.invalid/feed',fetchInterval:0});f.db.addEntries(feed.id,[{title:'Article',content:'<p>Preserved body</p>',hash:'body'}]);const entry=f.db.entries()[0];f.db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('archive',entry.id,feed.id,feed.title,'Archive',null,'date','date');f.db.db.prepare('INSERT INTO archive_versions(id,archive_id,content_hash,body_html,created_at) VALUES (?,?,?,?,?)').run('version','archive','hash','<p>Preserved archive</p>','date');
  mkdirSync(target,{recursive:true});f.db.saveCachedImage('https://fixture.invalid/image',name,'image/png',2*GIB); // Declared size triggers the normal 1GB quota without allocating gigabytes.
  await assert.rejects(f.cache.configure({maxBytes:GIB}),error=>error.settingsApplied===true&&/设置已保存/.test(error.message));assert.equal(f.cache.getSettings().maxBytes,GIB);assert.equal(JSON.parse(readFileSync(f.file)).imageCache.maxBytes,GIB);assert.equal(f.db.cachedImages().length,1);assert.equal(existsSync(target),true);assert.equal((await f.cache.stats()).needsCleanup,true);assert.ok((await f.cache.stats()).cleanupError);
  const reopened=new ImageCache(f.db,f.file,f.directory);assert.equal((await reopened.stats()).needsCleanup,true);assert.equal(reopened.getSettings().maxBytes,GIB);
  rmSync(target,{recursive:true});writeFileSync(target,'tiny fixture');await reopened.configure({maxBytes:GIB});assert.equal(existsSync(target),false);assert.equal(f.db.cachedImages().length,0);assert.deepEqual(await reopened.stats(),{count:0,bytes:0,cleanupError:null,needsCleanup:false});assert.equal(f.db.entry(entry.id).content,'<p>Preserved body</p>');assert.equal(f.db.db.prepare('SELECT body_html FROM archive_versions WHERE id=?').get('version').body_html,'<p>Preserved archive</p>');assert.equal(f.db.feeds().length,1);
 }finally{f.close();}
});
test('configuration cleanup shares the cache queue while preference publication stays immediate',async()=>{
 const f=fixture();let response,signal;const started=new Promise(resolve=>signal=resolve),origin=createServer((_req,res)=>{response=res;signal();});await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${origin.address().port}`,order=[],tasks=[];
 try{
  tasks.push(f.cache.cache(base+'/image',base,true).then(()=>order.push('cache')));await started;
  tasks.push(f.cache.configure({enabled:true,maxBytes:GIB}).then(value=>{order.push('first');assert.equal(value.enabled,true);}));tasks.push(f.cache.configure({enabled:false,maxBytes:2*GIB}).then(value=>{order.push('second');assert.equal(value.enabled,false);}));assert.deepEqual(f.cache.getSettings(),{enabled:false,maxBytes:2*GIB});assert.deepEqual(order,[]);
  response.setHeader('content-type','image/png');response.end('fixture image');await Promise.all(tasks);assert.deepEqual(order,['cache','first','second']);assert.equal(f.db.cachedImages().length,1);await f.cache.wait();
 }finally{if(response&&!response.writableEnded){response.setHeader('content-type','image/png');response.end('fixture image');}await Promise.allSettled(tasks);await new Promise(resolve=>origin.close(resolve));f.close();}
});
