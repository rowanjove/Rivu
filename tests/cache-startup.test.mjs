import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {ImageCache} from '../dist-server/image-cache.js';
import {RivuDatabase} from '../dist-server/database.cjs';
import {LocalReadingSettings} from '../dist-server/reading-settings.js';
const fs=createRequire(import.meta.url)('node:fs'),GIB=1024**3;
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-cache-startup-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-cache-startup-')&&!scope.startsWith('..')&&!isAbsolute(scope));const db=new RivuDatabase(join(directory,'rivu.db')),file=join(directory,'settings.json');return {directory,db,file,close(){db.close();rmSync(directory,{recursive:true,force:true});}};}
test('damaged startup settings are diagnosed without replacing the file or fetching and pruning cache',async()=>{
 const f=fixture(),name='b'.repeat(64)+'.png',url='https://fixture.invalid/image',bytes=Buffer.from('offline image');mkdirSync(join(f.directory,'cache','images'),{recursive:true});const target=join(f.directory,'cache','images',name);writeFileSync(target,bytes);f.db.saveCachedImage(url,name,'image/png',bytes.length);
 try{
  for(const raw of ['{broken','null','[]',JSON.stringify({imageCache:null}),JSON.stringify({imageCache:[]}),JSON.stringify({imageCache:{enabled:'true'}}),JSON.stringify({imageCache:{enabled:true,maxBytes:-1}}),JSON.stringify({imageCache:{enabled:true,maxBytes:3*GIB}}),JSON.stringify({imageCache:{enabled:true,unknown:1}})]){
   writeFileSync(f.file,raw);const cache=new ImageCache(f.db,f.file,f.directory);assert.throws(()=>cache.getSettings(),/图片缓存配置读取失败/);await assert.rejects(cache.configure({enabled:true}),/图片缓存配置读取失败/);await assert.rejects(cache.cache('https://fixture.invalid/new',undefined,true),/图片缓存配置读取失败/);
   assert.deepEqual(await cache.lookup(url),{dataUrl:'data:image/png;base64,'+bytes.toString('base64'),bytes:bytes.length});assert.equal(readFileSync(f.file,'utf8'),raw);assert.deepEqual(readFileSync(target),bytes);assert.equal(f.db.cachedImages().length,1);
  }
 }finally{f.close();}
});
test('only absence is a default configuration; legacy partial preferences remain valid',()=>{
 const f=fixture();try{
  assert.deepEqual(new ImageCache(f.db,f.file,f.directory).getSettings(),{enabled:false,maxBytes:GIB});
  for(const [document,expected] of [[{other:{keep:true}},{enabled:false,maxBytes:GIB}],[{imageCache:{enabled:true}},{enabled:true,maxBytes:GIB}],[{imageCache:{maxBytes:0}},{enabled:false,maxBytes:0}]]){writeFileSync(f.file,JSON.stringify(document));assert.deepEqual(new ImageCache(f.db,f.file,f.directory).getSettings(),expected);assert.deepEqual(JSON.parse(readFileSync(f.file)),document);}
 }finally{f.close();}
});
test('a real startup read error is exposed and a later read-only reload recovers original preferences',async()=>{
 const f=fixture(),saved={extra:{keep:true},imageCache:{enabled:true,maxBytes:10*GIB}};writeFileSync(f.file,JSON.stringify(saved));const before=readFileSync(f.file),original=fs.readFileSync;
 try{
  mock.method(fs,'readFileSync',(path,...args)=>{if(path===f.file)throw Object.assign(Error('fixture access denied'),{code:'EACCES'});return original(path,...args);});syncBuiltinESMExports();const cache=new ImageCache(f.db,f.file,f.directory);assert.throws(()=>cache.getSettings(),/配置读取失败/);await assert.rejects(cache.configure({maxBytes:GIB}),/配置读取失败/);mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(cache.getSettings(),saved.imageCache);assert.deepEqual(readFileSync(f.file),before);
  await cache.configure({enabled:false});assert.deepEqual(JSON.parse(readFileSync(f.file)),{...saved,imageCache:{...saved.imageCache,enabled:false}});
 }finally{mock.restoreAll();syncBuiltinESMExports();f.close();}
});
test('repairing an invalid startup document requires no write request and restores its actual quota',async()=>{
 const f=fixture();try{writeFileSync(f.file,'{broken');const cache=new ImageCache(f.db,f.file,f.directory);assert.throws(()=>cache.getSettings());const repaired={extra:'preserved',imageCache:{enabled:true,maxBytes:5*GIB}};writeFileSync(f.file,JSON.stringify(repaired));const before=readFileSync(f.file);assert.deepEqual(cache.getSettings(),repaired.imageCache);assert.deepEqual(readFileSync(f.file),before);const copy=cache.getSettings();copy.maxBytes=GIB;assert.equal(cache.getSettings().maxBytes,5*GIB);}finally{f.close();}
});
test('reading initialization cannot replace damaged document roots before the cache reports them',()=>{
 const f=fixture();try{for(const raw of ['null','[]','{broken']){writeFileSync(f.file,raw);const reading=new LocalReadingSettings(f.file);assert.throws(()=>reading.update({theme:'light'}));assert.equal(readFileSync(f.file,'utf8'),raw);assert.throws(()=>new ImageCache(f.db,f.file,f.directory).getSettings(),/配置读取失败/);}}finally{f.close();}
});
