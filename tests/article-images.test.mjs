import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('cache refresh preserves article visibility gating and releases hidden old resources',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rivu-article-images-')),output=join(directory,'observer.mjs');
 const previous={window:globalThis.window,IntersectionObserver:globalThis.IntersectionObserver};
 const loads=[],released=[],events=new Map(),images=[{dataset:{rivuUrl:'one'}},{dataset:{rivuUrl:'two'}},{dataset:{rivuUrl:'three'}}];let callback,disconnected=false;
 try{
  globalThis.__articleImageLoad=(image,id,url)=>{loads.push({image,id,url});return ()=>released.push(image);};
  await build({entryPoints:['src/article-images.ts'],outfile:output,bundle:true,platform:'node',format:'esm',plugins:[{name:'loader',setup(build){build.onResolve({filter:/native-image$/},()=>({path:'loader',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const loadNativeImage=(...args)=>globalThis.__articleImageLoad(...args);',loader:'js'}));}}]});
  globalThis.window={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  globalThis.IntersectionObserver=class{constructor(fn,options){callback=fn;assert.equal(options.rootMargin,'300px');}observe(){}disconnect(){disconnected=true;}};
  const {observeArticleImages}=await import(pathToFileURL(output));
  const dispose=observeArticleImages({closest:()=>null,querySelectorAll:()=>images},'entry');
  const refresh=events.get('rivu-image-cache-updated');refresh();assert.equal(loads.length,0);
  callback([{target:images[0],isIntersecting:true}]);assert.equal(loads.length,1);
  callback([{target:images[0],isIntersecting:true}]);assert.equal(loads.length,1);
  refresh();assert.equal(loads.length,2);assert.deepEqual(released,[images[0]]);
  callback([{target:images[0],isIntersecting:false}]);assert.equal(released.length,2,'leaving viewport releases without a cache event');refresh();assert.equal(loads.length,2);assert.equal(released.length,2);
  callback([{target:images[0],isIntersecting:true},{target:images[1],isIntersecting:true}]);assert.equal(loads.length,4);assert.ok(loads.every(row=>row.id==='entry'&&row.image!==images[2]));
  dispose();assert.equal(disconnected,true);assert.equal(events.size,0);assert.equal(released.length,4);
  dispose();refresh();callback([{target:images[2],isIntersecting:true}]);assert.equal(loads.length,4);assert.equal(released.length,4);
 }finally{globalThis.window=previous.window;globalThis.IntersectionObserver=previous.IntersectionObserver;delete globalThis.__articleImageLoad;rmSync(directory,{recursive:true,force:true});}
});
