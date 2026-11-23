import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
assert.equal(process.env.RIVU_NATIVE_CREATE_FIXTURE,'1','此入口会复制大型压测库。日常复测请复用已有隔离夹具；确需新建时显式设置 RIVU_NATIVE_CREATE_FIXTURE=1。');
// Refusal must not load desktop automation/database modules either.
const {_electron:electron}=await import('playwright-core');
const {validateUnreadCounts}=await import('../dist-server/unread-counts.js');
const {RivuDatabase,SCHEMA_VERSION}=await import('../dist-server/database.cjs');
const harnessSHA256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
const sourceManifest=process.env.RIVU_IMAGE_SOURCE_MANIFEST||'artifacts/native-image-source-v43-20261028.json';
const source=JSON.parse(readFileSync(sourceManifest,'utf8')),scope=relative(resolve('bench-data'),resolve(source.databasePath));
assert.ok(scope.startsWith(`rivu-schema${SCHEMA_VERSION}-migration-`)&&!scope.includes('..')&&!isAbsolute(scope));assert.equal(source.schemaVersion,SCHEMA_VERSION);assert.ok(process.env.RIVU_TEST_EXE);assert.ok(process.env.RIVU_IMAGE_RESULT);assert.ok(!existsSync(process.env.RIVU_IMAGE_RESULT));
const imageMiB=Number(process.env.RIVU_IMAGE_MIB||1);assert.ok([1,8].includes(imageMiB),'image size must be 1 or 8 MiB');
const directory=mkdtempSync(join(resolve('bench-data'),`rivu-native-writer-v${SCHEMA_VERSION}-`)),databasePath=join(directory,'rivu.db'),origin=new DatabaseSync(source.databasePath,{readOnly:true});
try{await backup(origin,databasePath);}finally{origin.close();}
const url='https://example.invalid/cached-benchmark.png',file=createHash('sha256').update(url).digest('hex')+'.png',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64'),bytes=Buffer.concat([png,Buffer.alloc(imageMiB*1024*1024-png.length)]);
mkdirSync(join(directory,'cache','images'),{recursive:true});writeFileSync(join(directory,'cache','images',file),bytes);
const model=new RivuDatabase(databasePath,undefined,true),db=model.db;let ids,entryId;
try{
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(db.prepare('SELECT count(*) n FROM entries').get().n,500000);
 ids=db.prepare('SELECT id FROM feeds WHERE category_id=? ORDER BY id LIMIT 500').all(source.categories.broad).map(row=>row.id);assert.equal(ids.length,500);
 const entry=db.prepare('SELECT id,content FROM entries WHERE feed_id IN (SELECT id FROM feeds WHERE category_id=?) LIMIT 1').get(source.categories.other);entryId=entry.id;
 db.prepare('UPDATE entries SET content=? WHERE id=?').run(entry.content+`<img src="${url}">`,entryId);
 db.prepare('INSERT INTO cached_images(url,file_name,mime,bytes,saved_at,last_accessed_at) VALUES (?,?,?,?,?,?)').run(url,file,'image/png',bytes.length,'2000','2000');
}finally{model.close();}
let application;
let rendererNetworkSession;
let recording=false;
const chromeTracePath=process.env.RIVU_NATIVE_CHROME_TRACE;
if(chromeTracePath)assert.ok(!existsSync(chromeTracePath),'Chrome trace output already exists');
const traceEnabled=process.env.RIVU_NATIVE_TRACE==='1';
const disableNetworkAgent=process.env.RIVU_NATIVE_NO_NETWORK_AGENT==='1';
const probeVisible=process.env.RIVU_NATIVE_VISIBLE_PROBE==='1';
const contentProbe=process.env.RIVU_NATIVE_CONTENT_PROBE==='1';
// Diagnostic only: the default keeps the production browser decoding hint.
const decodeHint=process.env.RIVU_NATIVE_DECODE_HINT||'auto';
assert.ok(['auto','sync','async'].includes(decodeHint));
const decodeExperiment=process.env.RIVU_NATIVE_DECODE_EXPERIMENT||'none';
assert.ok(['none','deduplicate','software-raster','limited-parking'].includes(decodeExperiment));
const taskFlow=process.env.RIVU_NATIVE_TASK_FLOW==='1';
const measureMemory=process.env.RIVU_NATIVE_MEMORY==='1';
const lifecycleProbe=process.env.RIVU_NATIVE_LIFECYCLE==='1';
const resourceProbe=process.env.RIVU_NATIVE_RESOURCE_PROBE==='1';
const retireReplacement=process.env.RIVU_NATIVE_RETIRE_REPLACEMENT==='1';
// Diagnostic only: request decoding as soon as src is assigned, before load.
const earlyDecode=process.env.RIVU_NATIVE_EARLY_DECODE==='1';
const idleControl=process.env.RIVU_NATIVE_IDLE_CONTROL==='1';
const expectedRuntime=process.env.RIVU_NATIVE_RUNTIME_VERSION||'';
async function installMeasure(page){
 await page.evaluate(({probeVisible,markTrace,contentProbe,decodeHint,lifecycleProbe,resourceProbe,retireReplacement,earlyDecode})=>{
  if(lifecycleProbe)window.__nativeImageLifecycle={created:0,completed:0,refs:[]};
  if(resourceProbe)window.__nativeResourceSamples=[];
  const resourceSample=phase=>{if(resourceProbe&&window.__nativeResourceSamples.length<1000)window.__nativeResourceSamples.push({phase,at:performance.now(),images:window.__rivuImageCache.usage().images});};
  window.__measureNativeImage=async(entryId,url,mode='load',existing)=>{
   const at=performance.now(),src=existing||await window.rivu.imageUrl(entryId,url,mode),minted=performance.now(),image=new Image();let loadedAt,decodedAt;
   if(lifecycleProbe){const state=window.__nativeImageLifecycle;state.created++;if(state.refs.length<1000)state.refs.push(new WeakRef(image));}
   resourceSample('created');
   image.decoding=decodeHint;const serial=new URL(src).searchParams.get('v');
   const mark=phase=>{if(markTrace){const name=`rivu-native:${serial}:${phase}`;performance.mark(name);performance.clearMarks(name);}};
   image.style.cssText=contentProbe?`position:fixed;left:${mode==='lookup'?650:700}px;top:120px;width:32px;height:32px;opacity:${probeVisible?1:0};pointer-events:none;z-index:2147483647`:`position:fixed;left:0;top:0;width:1px;height:1px;opacity:${probeVisible?1:0};pointer-events:none;z-index:2147483647`;
   return new Promise((resolve,reject)=>{
    let finished=false;const timer=setTimeout(()=>finish(Error('native image timed out')),10000);
    const finish=async error=>{if(finished)return;finished=true;if(lifecycleProbe)window.__nativeImageLifecycle.completed++;const width=image.naturalWidth,height=image.naturalHeight;clearTimeout(timer);image.onload=null;image.onerror=null;let retirementMs=0;
     if(retireReplacement&&!error){const retirementAt=performance.now();let retirementTimer;try{image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=';await Promise.race([image.decode(),new Promise((_,reject)=>{retirementTimer=setTimeout(()=>reject(Error('replacement retirement timed out')),2000);})]);}catch(cause){error=cause;}finally{clearTimeout(retirementTimer);retirementMs=performance.now()-retirementAt;}}
     image.removeAttribute('src');image.remove();resourceSample('released');if(error)reject(error);else resolve({ms:performance.now()-at,width,height,mintMs:minted-at,loadMs:loadedAt-minted,decodeMs:decodedAt-loadedAt,retirementMs,serial:new URL(src).searchParams.get('v')});};
    let decoding;
    image.onload=()=>{loadedAt=performance.now();mark('loaded');void (decoding||image.decode()).then(()=>{decodedAt=performance.now();mark('decoded');if(image.naturalWidth!==1||image.naturalHeight!==1)finish(Error('decoded dimensions differ'));else finish();},()=>finish(Error('native decode failed')));};
    image.onerror=()=>finish(Error('native image failed'));document.body.append(image);mark('assigned');image.src=src;
    if(earlyDecode){decoding=image.decode();void decoding.catch(()=>{});}
   });
  };
 },{probeVisible,markTrace:!!chromeTracePath,contentProbe,decodeHint,lifecycleProbe,resourceProbe,retireReplacement,earlyDecode});
}
async function boundaryChecks(app,page){
 const seen=[];const proxy=createServer((req,res)=>{const control=!!req.url?.includes('/native-proxy-control');seen.push({control,hadToken:typeof req.headers['x-rivu-token']==='string'});res.writeHead(control?200:502,{'Content-Type':'text/plain'});res.end(control?'control':'unexpected proxy request');});
 await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
 let proxyCheck;
 try{
  const configured=await app.evaluate(async({session},port)=>{
   await session.defaultSession.setProxy({proxyRules:'http=127.0.0.1:'+port,proxyBypassRules:'<-loopback>'});
   const target='http://127.0.0.1:65439/native-proxy-control',defaultRoute=await session.defaultSession.resolveProxy(target);
   const response=await session.defaultSession.fetch(target,{credentials:'omit',redirect:'manual'});return {defaultRoute,controlStatus:response.status,controlBody:await response.text()};
  },proxy.address().port);
  assert.match(configured.defaultRoute,/PROXY 127\.0\.0\.1:/);assert.equal(configured.controlStatus,200);assert.equal(configured.controlBody,'control');assert.deepEqual(seen,[{control:true,hadToken:false}]);
  await page.evaluate(({entryId,url})=>window.__measureNativeImage(entryId,url),{entryId,url});
  assert.deepEqual(seen,[{control:true,hadToken:false}]);proxyCheck={...configured,requestsSeen:seen.length,tokenHeadersSeen:seen.filter(row=>row.hadToken).length,scope:'Cached native decode under a verified default-session proxy; no claim about remote-origin routing'};
 }finally{try{await app.evaluate(async({session})=>{await session.defaultSession.setProxy({mode:'system'});});}finally{proxy.closeAllConnections();await new Promise(done=>proxy.close(done));}}
 const old=await page.evaluate(({entryId,url})=>window.rivu.imageUrl(entryId,url),{entryId,url});let staleStatus;
 const observer=response=>{if(response.url()===old)staleStatus=response.status();};page.on('response',observer);
 try{
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.feed-nav').length===1000);await installMeasure(page);
  const rejected=await page.evaluate(async({entryId,url,old})=>{try{await window.__measureNativeImage(entryId,url,'load',old);return false;}catch{return true;}},{entryId,url,old});assert.equal(rejected,true);assert.equal(staleStatus,403);
  await page.evaluate(({entryId,url})=>window.__measureNativeImage(entryId,url),{entryId,url});
  return {proxy:proxyCheck,staleNavigationStatus:staleStatus,freshNavigationDecoded:true};
 }finally{page.off('response',observer);}
}
try{
 const experimentArgs=decodeExperiment==='deduplicate'?['--enable-features=PreventDuplicateImageDecodes']:decodeExperiment==='software-raster'?['--disable-gpu-rasterization']:decodeExperiment==='limited-parking'?['--enable-features=CompressParkableStrings:max_disk_capacity_mb/1']:[];
 application=await electron.launch({executablePath:resolve(process.env.RIVU_TEST_EXE),args:['--no-sandbox',...experimentArgs],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+60000;while(Date.now()<deadline){page=application.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 if(resourceProbe){
  const preload=join(directory,'cache-diagnostic-preload.cjs');
  writeFileSync(preload,"const {contextBridge,webFrame}=require('electron');contextBridge.exposeInMainWorld('__rivuImageCache',{usage:()=>webFrame.getResourceUsage()});");
  await application.evaluate(({session},filePath)=>session.defaultSession.registerPreloadScript({type:'frame',filePath}),preload);
  await page.reload();await page.waitForFunction(()=>!!window.__rivuImageCache);
 }
 await page.waitForFunction(()=>document.querySelectorAll('.feed-nav').length===1000);await page.locator('.entry-row').first().waitFor();await installMeasure(page);
 if(disableNetworkAgent){
  // Playwright 1.63 enables a renderer Network agent automatically. Disable only
  // its recording during the timing window, not application networking or cache.
  rendererNetworkSession=page._connection.toImpl(page).delegate._mainFrameSession._client;
  assert.ok(rendererNetworkSession?.send);await rendererNetworkSession.send('Network.disable');
 }
 if(traceEnabled)await application.evaluate(({session})=>{
  globalThis.__nativeNetwork=[];const starts=new Map();
  for(const [kind,ses]of [['scheme',session.defaultSession]]){
   ses.webRequest.onBeforeRequest((details,callback)=>{if(details.url.startsWith('rivu-image:'))starts.set(kind+details.id,{at:Date.now(),mono:performance.now(),serial:new URL(details.url).searchParams.get('v')});callback({});});
   const finish=(details,failed)=>{const start=starts.get(kind+details.id);if(start){starts.delete(kind+details.id);globalThis.__nativeNetwork.push({kind,id:details.id,serial:start.serial,startEpochMs:start.at,ms:performance.now()-start.mono,status:details.statusCode||null,failed});}};
   ses.webRequest.onCompleted(details=>finish(details,false));ses.webRequest.onErrorOccurred(details=>finish(details,true));
  }
 });
 const runtime=await application.evaluate(({app,BrowserWindow})=>({versions:process.versions,enabledFeatures:app.commandLine.getSwitchValue('enable-features'),disabledFeatures:app.commandLine.getSwitchValue('disable-features'),gpuFeatures:app.getGPUFeatureStatus(),windows:BrowserWindow.getAllWindows().map(win=>({visible:win.isVisible(),focused:win.isFocused(),minimized:win.isMinimized()}))}));
 if(expectedRuntime)assert.equal(runtime.versions.electron,expectedRuntime);
 if(measureMemory)await application.evaluate(({app})=>{
  globalThis.__nativeMemory=[];
  globalThis.__sampleNativeMemory=()=>{if(globalThis.__nativeMemory.length<1000)globalThis.__nativeMemory.push({at:Date.now(),processes:app.getAppMetrics().map(({pid,type,memory})=>({pid,type,...memory}))});};
  globalThis.__sampleNativeMemory();globalThis.__nativeMemoryTimer=setInterval(globalThis.__sampleNativeMemory,250);
 });
 const initial=await page.evaluate(async({entryId,url})=>{const times=[];for(const mode of ['lookup','load'])times.push(await window.__measureNativeImage(entryId,url,mode));return times;},{entryId,url});
 if(chromeTracePath){await application.evaluate(async({contentTracing},taskFlow)=>{await contentTracing.startRecording({included_categories:['devtools.timeline','disabled-by-default-devtools.timeline','blink','blink.user_timing','v8','cc','disabled-by-default-cc.debug','viz',...(taskFlow?['toplevel','toplevel.flow','base','sequence_manager']:[])]});},taskFlow);recording=true;}
 if(traceEnabled)await page.evaluate(()=>{
  window.__nativeRenderer={startedAt:Date.now(),visibility:document.visibilityState,focused:document.hasFocus(),maxLoopGapMs:0,gaps:[],longTasks:[],visibilityTransitions:[]};let at=performance.now();
  window.__nativeRenderTimer=setInterval(()=>{const now=performance.now(),gap=now-at;window.__nativeRenderer.maxLoopGapMs=Math.max(window.__nativeRenderer.maxLoopGapMs,gap);if(gap>50&&window.__nativeRenderer.gaps.length<200)window.__nativeRenderer.gaps.push({startEpochMs:performance.timeOrigin+at,ms:gap});at=now;},10);
  window.__nativeVisibility=()=>window.__nativeRenderer.visibilityTransitions.push({at:Date.now(),state:document.visibilityState});document.addEventListener('visibilitychange',window.__nativeVisibility);
  window.__nativeTaskObserver=new PerformanceObserver(list=>{for(const item of list.getEntries())if(window.__nativeRenderer.longTasks.length<200)window.__nativeRenderer.longTasks.push({startEpochMs:performance.timeOrigin+item.startTime,ms:item.duration});});window.__nativeTaskObserver.observe({entryTypes:['longtask']});
 });
 await application.evaluate(()=>{globalThis.__nativeRead={maxLoopGapMs:0};let at=performance.now();globalThis.__nativeReadTimer=setInterval(()=>{const now=performance.now();globalThis.__nativeRead.maxLoopGapMs=Math.max(globalThis.__nativeRead.maxLoopGapMs,now-at);at=now;},10);});
 const metrics=await page.evaluate(async({ids,categoryId,entryId,url,traceEnabled,idleControl})=>{
  const samples=[[],[],[]],details=[[],[],[]];let active=true;const at=performance.now(),write=(idleControl?new Promise(resolve=>setTimeout(()=>resolve(null),10000)):window.rivu.request('POST','/api/feeds/bulk',{ids,action:'category',categoryId})).finally(()=>active=false);
  const poll=(async()=>{while(active){await Promise.all([0,1,2].map(async index=>{const start=performance.now(),startEpochMs=performance.timeOrigin+start;let image;if(index===0)await window.rivu.request('GET','/health');else image=await window.__measureNativeImage(entryId,url,index===1?'lookup':'load');const ms=performance.now()-start;samples[index].push(ms);if(traceEnabled)details[index].push({startEpochMs,totalMs:ms,image});}));await new Promise(done=>setTimeout(done,25));}})();
  let result;try{result=await write;}finally{await poll;}if(!idleControl&&(result.changed!==500||result.action!=='category'))throw Error('bulk category response differs');
  return {workload:idleControl?'idle-control':'bulk-category-500',changed:idleControl?null:result.changed,writeMs:idleControl?null:Math.round(performance.now()-at),observationMs:Math.round(performance.now()-at),samples:samples.map(rows=>rows.length),maxMs:samples.map(rows=>Math.round(Math.max(...rows))),under100:samples.every(rows=>rows.length>0&&rows.every(ms=>ms<100)),decodedImageSamples:samples[1].length+samples[2].length,...(traceEnabled?{details}:{})};
 },{ids,categoryId:source.categories.balanced,entryId,url,traceEnabled,idleControl});
 const main=await application.evaluate(()=>{clearInterval(globalThis.__nativeReadTimer);return globalThis.__nativeRead;});
 if(recording){await application.evaluate(async({contentTracing},path)=>contentTracing.stopRecording(path),resolve(chromeTracePath));recording=false;}
 const trace=traceEnabled?{renderer:await page.evaluate(()=>{clearInterval(window.__nativeRenderTimer);window.__nativeTaskObserver.disconnect();document.removeEventListener('visibilitychange',window.__nativeVisibility);return {...window.__nativeRenderer,endingVisibility:document.visibilityState,endingFocused:document.hasFocus()};}),network:await application.evaluate(()=>globalThis.__nativeNetwork),initialStages:initial}:null;
 if(rendererNetworkSession){await rendererNetworkSession.send('Network.enable');rendererNetworkSession=undefined;}
 // Capture raw bytes after the formal timing window; enabling CDP buffering must
 // not become part of the long-write performance workload.
 const cdp=await page.context().newCDPSession(page);let requestId;
 cdp.on('Network.responseReceived',event=>{if(event.response.url.startsWith('rivu-image://local/'))requestId=event.requestId;});
 await cdp.send('Network.enable',{maxTotalBufferSize:64*1024*1024,maxResourceBufferSize:16*1024*1024});await page.evaluate(({entryId,url})=>window.__measureNativeImage(entryId,url),{entryId,url});assert.ok(requestId);
 const body=await cdp.send('Network.getResponseBody',{requestId}),captured=Buffer.from(body.body,body.base64Encoded?'base64':'utf8');assert.deepEqual(captured,bytes);const wireBody={bytes:captured.length,sha256:createHash('sha256').update(captured).digest('hex'),matchesExpected:true};await cdp.send('Network.disable');await cdp.detach();
 const boundaries=process.env.RIVU_NATIVE_BOUNDARIES==='1'?await boundaryChecks(application,page):null;
 let lifecycle=null;if(lifecycleProbe){
  const snapshot=()=>page.evaluate(()=>{const state=window.__nativeImageLifecycle;return {created:state.created,completed:state.completed,tracked:state.refs.length,live:state.refs.reduce((n,ref)=>n+(ref.deref()?1:0),0)};});
  const processMemory=()=>application.evaluate(({app})=>app.getAppMetrics().map(({pid,type,memory})=>({pid,type,memory})));
  const before=await snapshot(),memoryBefore=await processMemory(),cacheBefore=resourceProbe?await page.evaluate(()=>window.__rivuImageCache.usage()):null,collector=await page.context().newCDPSession(page);
  try{await collector.send('HeapProfiler.collectGarbage');}finally{await collector.detach();}
  const after=await snapshot(),memoryAfter=await processMemory(),cacheAfter=resourceProbe?await page.evaluate(()=>window.__rivuImageCache.usage()):null;
  lifecycle={before,after,memoryBefore,memoryAfter,cacheBefore,cacheAfter,scope:'Diagnostic only; forced GC after all timed measurements and wire checks, no baseline gate pass claim'};
 }
 const resources=resourceProbe?await page.evaluate(()=>window.__nativeResourceSamples):null;
 let memory=null;if(measureMemory){await new Promise(done=>setTimeout(done,5000));memory=await application.evaluate(()=>{globalThis.__sampleNativeMemory();clearInterval(globalThis.__nativeMemoryTimer);return {units:'KiB',sampleIntervalMs:250,idleAfterMeasurementMs:5000,samples:globalThis.__nativeMemory};});}
 await application.close();application=undefined;
 const verify=new DatabaseSync(databasePath,{readOnly:true});let lastAccess;
 try{validateUnreadCounts(verify);assert.deepEqual(verify.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(verify.prepare('SELECT count(*) n FROM entries').get().n,500000);assert.equal(verify.prepare('SELECT count(*) n FROM feeds').get().n,1000);lastAccess=verify.prepare('SELECT last_accessed_at FROM cached_images WHERE url=?').get(url).last_accessed_at;assert.notEqual(lastAccess,'2000');}finally{verify.close();}
 assert.equal(createHash('sha256').update(readFileSync(join(directory,'cache','images',file))).digest('hex'),wireBody.sha256);
 const result={schemaVersion:SCHEMA_VERSION,sourceManifest,harnessSHA256,expectedRuntime,runtime,memory,lifecycle,resources,taskFlow,decodeHint,decodeExperiment,retireReplacement,earlyDecode,instrumentation:{requestTiming:traceEnabled,memory:measureMemory,chromeTrace:!!chromeTracePath,taskFlow},diagnostic:earlyDecode||traceEnabled||measureMemory||!!chromeTracePath||retireReplacement||idleControl||!!expectedRuntime||disableNetworkAgent||resourceProbe||lifecycleProbe||decodeHint!=='auto'||decodeExperiment!=='none',executablePath:resolve(process.env.RIVU_TEST_EXE),directory,databasePath,sourceDatabasePath:source.databasePath,cacheBytes:bytes.length,initialReadMs:initial.map(row=>Math.round(row.ms)),initialRawMs:initial.map(row=>row.ms),metrics,main,wireBody,boundaries,trace,disableNetworkAgent,probeVisible,contentProbe,lastAccess,countersConsistent:true,scope:`Native browser image load+decode in synthetic500k fixture; ${probeVisible?'visible':'opacity-zero'} ${contentProbe?'separated32px content':'overlapping1px corner'} probes, not physical painting/60FPS; full bytes checked once after timing`};
 writeFileSync(process.env.RIVU_IMAGE_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 if(process.env.RIVU_REQUIRE_SCALE==='1')assert.ok(metrics.under100,'native images during observation must remain <100ms');
 if(process.env.RIVU_REQUIRE_IMAGE_COLD==='1')assert.ok(result.initialRawMs.every(ms=>ms<100),'initial native images must remain <100ms');
}finally{if(recording)await application?.evaluate(async({contentTracing},path)=>contentTracing.stopRecording(path),resolve(chromeTracePath)).catch(()=>{});if(rendererNetworkSession)await rendererNetworkSession.send('Network.enable').catch(()=>{});await application?.close();console.log('Temporary native benchmark fixture:',directory);}
