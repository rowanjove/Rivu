import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {LocalReadingSettings} from '../dist-server/reading-settings.js';
const fs=createRequire(import.meta.url)('node:fs');
const preferences={density:'compact',uiFontSize:'large',theme:'dark',font:'serif',fontSize:20,lineHeight:2,width:840,imageWidth:'wide',linkTarget:'ask'};
function fixture(){const directory=mkdtempSync(join(tmpdir(),'rivu-reading-reliable-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-reading-reliable-')&&!scope.startsWith('..')&&!isAbsolute(scope));const file=join(directory,'settings.json'),initial={extra:{keep:true},imageCache:{enabled:true,maxBytes:0},reading:preferences};writeFileSync(file,JSON.stringify(initial));return {directory,file,initial,reading:new LocalReadingSettings(file),close(){rmSync(directory,{recursive:true,force:true});}};}
test('invalid startup reading preferences remain unknown and cannot be replaced with defaults',()=>{
 const f=fixture();try{
  for(const raw of ['{broken','null','[]',JSON.stringify({reading:null}),JSON.stringify({reading:[]}),JSON.stringify({reading:{...preferences,fontSize:999}}),JSON.stringify({reading:{...preferences,extra:1}}),JSON.stringify({reading:{theme:'dark'}})]){writeFileSync(f.file,raw);const reading=new LocalReadingSettings(f.file);assert.throws(()=>reading.get(),/阅读配置读取失败/);assert.throws(()=>reading.update({theme:'light'}),/阅读配置读取失败/);assert.equal(readFileSync(f.file,'utf8'),raw);}
 }finally{f.close();}
});
test('read-only recovery retains actual preferences, legacy density handling and snapshot isolation',()=>{
 const f=fixture();try{
  writeFileSync(f.file,'{broken');const reading=new LocalReadingSettings(f.file);assert.throws(()=>reading.get());writeFileSync(f.file,JSON.stringify(f.initial));const before=readFileSync(f.file),snapshot=reading.get();assert.deepEqual(snapshot,{preferences,configured:true,densityConfigured:true});snapshot.preferences.fontSize=14;assert.equal(reading.get().preferences.fontSize,20);assert.deepEqual(readFileSync(f.file),before);
  const {density,uiFontSize,...legacy}=preferences;writeFileSync(f.file,JSON.stringify({reading:legacy}));const legacySettings=new LocalReadingSettings(f.file),result=legacySettings.get();assert.equal(result.preferences.theme,'dark');assert.equal(result.densityConfigured,false);assert.equal(result.preferences.density,'standard');assert.equal(legacySettings.update({theme:'light'}).densityConfigured,false);assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.file)).reading,'density'),false);assert.equal(legacySettings.update({density:'compact'}).densityConfigured,true);
  rmSync(f.file);const missing=new LocalReadingSettings(f.file);assert.equal(missing.get().configured,false);assert.equal(missing.get().preferences.theme,'light');missing.update({fontSize:18});assert.equal(JSON.parse(readFileSync(f.file)).reading.fontSize,18);
 }finally{f.close();}
});
for(const phase of ['write','rename'])test(`real reading ${phase} failure preserves memory and the complete file, cleaning its staged file`,()=>{
 const f=fixture(),before=readFileSync(f.file);
 try{
  if(phase==='rename'){const original=fs.renameSync;mock.method(fs,'renameSync',(source,destination)=>{if(destination===f.file)throw Error('fixture reading rename failure');return original(source,destination);});}
  else{const original=fs.writeFileSync;mock.method(fs,'writeFileSync',(path,...args)=>{if(typeof path==='number'){original(path,'partial stage');throw Error('fixture reading write failure');}return original(path,...args);});}
  syncBuiltinESMExports();assert.throws(()=>f.reading.update({fontSize:18}),/fixture reading/);assert.deepEqual(f.reading.get().preferences,preferences);assert.deepEqual(readFileSync(f.file),before);assert.equal(readdirSync(f.directory).some(n=>n.startsWith('settings.json.')&&n.endsWith('.tmp')),false);
  mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(f.reading.update({fontSize:18}).preferences,{...preferences,fontSize:18});assert.deepEqual(JSON.parse(readFileSync(f.file)),{...f.initial,reading:{...preferences,fontSize:18}});assert.equal(new LocalReadingSettings(f.file).get().preferences.fontSize,18);
 }finally{mock.restoreAll();syncBuiltinESMExports();f.close();}
});
test('startup access errors and newly damaged files are not mistaken for absence',()=>{
 const f=fixture(),before=readFileSync(f.file),original=fs.readFileSync;
 try{
  mock.method(fs,'readFileSync',(path,...args)=>{if(path===f.file)throw Object.assign(Error('fixture access denied'),{code:'EACCES'});return original(path,...args);});syncBuiltinESMExports();const failed=new LocalReadingSettings(f.file);assert.throws(()=>failed.get(),/阅读配置读取失败/);assert.throws(()=>f.reading.update({fontSize:18}),/阅读配置读取失败/);mock.restoreAll();syncBuiltinESMExports();assert.deepEqual(failed.get().preferences,preferences);assert.deepEqual(readFileSync(f.file),before);
  for(const raw of ['null','[]',JSON.stringify({...f.initial,reading:{...preferences,width:123}})]){writeFileSync(f.file,raw);assert.throws(()=>f.reading.update({fontSize:18}),/阅读配置读取失败/);assert.equal(readFileSync(f.file,'utf8'),raw);assert.throws(()=>f.reading.get(),/阅读配置读取失败/);writeFileSync(f.file,JSON.stringify(f.initial));assert.deepEqual(f.reading.get().preferences,preferences);}
 }finally{mock.restoreAll();syncBuiltinESMExports();f.close();}
});
test('GET revalidates current disk preferences and partial updates preserve externally repaired values',()=>{
 const f=fixture();try{const repaired={...f.initial,reading:{...preferences,fontSize:18,width:680}};writeFileSync(f.file,JSON.stringify(repaired));const before=readFileSync(f.file);assert.deepEqual(f.reading.get().preferences,repaired.reading);assert.deepEqual(readFileSync(f.file),before);f.reading.update({theme:'light'});assert.deepEqual(JSON.parse(readFileSync(f.file)),{...repaired,reading:{...repaired.reading,theme:'light'}});}finally{f.close();}
});
