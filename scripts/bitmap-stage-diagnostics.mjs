// Test-only instrumentation. No payload bytes, capability strings or service tokens recorded.
export async function installMainByteStages(application,imagePath){
 await application.evaluate(({ipcMain},target)=>{
  const fs=process.getBuiltinModule('node:fs/promises'),{AsyncLocalStorage}=process.getBuiltinModule('node:async_hooks');
  const storage=new AsyncLocalStorage(),originalRead=fs.readFile,original=ipcMain._invokeHandlers.get('rivu:image-bytes');
  const threads=process.getBuiltinModule('node:worker_threads'),OriginalWorker=threads.Worker;
  if(!original||globalThis.__byteStages)throw Error('Byte stage diagnostic already installed or handler missing');
  const state={ipc:[],files:[],workers:[],loop:[],restore:null},push=(rows,value)=>{if(rows.length<2048)rows.push(value);};
  globalThis.__byteStages=state;
  const TracedWorker=new Proxy(OriginalWorker,{construct(Target,args,newTarget){
   const worker=Reflect.construct(Target,args,newTarget),options=args[1];
   if(options?.workerData?.kind==='image_urls'||options?.workerData?.persistentImages){
    const at=performance.now(),record={id:storage.getStore()??null,startEpochMs:performance.timeOrigin+at,oldGenerationMb:options.resourceLimits?.maxOldGenerationSizeMb,lightImageModule:!!options.workerData.imageModulePath};push(state.workers,record);
    worker.once('online',()=>record.onlineMs=performance.now()-at);
    worker.once('message',message=>{record.replyMs=performance.now()-at;record.resultValid=Array.isArray(message?.result)&&message.result.every(value=>typeof value==='string');record.failed=!!message?.error;});
    worker.once('error',()=>record.failed=true);worker.once('exit',code=>{record.exitMs=performance.now()-at;record.exitCode=code;});
   }
   return worker;
  }});threads.Worker=TracedWorker;
  const wrapped=async(...args)=>{
   const id=new URL(args[1]).searchParams.get('v'),at=performance.now(),cpu=typeof process.threadCpuUsage==='function'?process.threadCpuUsage():null;
   let ok=false,value;
   try{value=await storage.run(id,()=>original(...args));ok=true;return value;}
   finally{
    const used=cpu?process.threadCpuUsage(cpu):null;
    push(state.ipc,{id,startEpochMs:performance.timeOrigin+at,ms:performance.now()-at,ok,cpuMs:used?(used.user+used.system)/1000:null,bytes:value?.imageBytes?.byteLength??null,backingBytes:value?.imageBytes?.buffer?.byteLength??null});
   }
  };
  ipcMain.removeHandler('rivu:image-bytes');ipcMain.handle('rivu:image-bytes',wrapped);
  fs.readFile=async function(...args){
   if(String(args[0]).toLowerCase()!==target.toLowerCase())return originalRead.apply(this,args);
   const id=storage.getStore()??null,at=performance.now();let value,ok=false;
   try{value=await originalRead.apply(this,args);ok=true;return value;}
   finally{push(state.files,{id,startEpochMs:performance.timeOrigin+at,ms:performance.now()-at,ok,bytes:value?.byteLength??null});}
  };
  let previous=performance.now();const timer=setInterval(()=>{const now=performance.now(),ms=now-previous;previous=now;if(ms>20)push(state.loop,{atEpochMs:performance.timeOrigin+now,ms});},5);timer.unref();
  state.restore=()=>{clearInterval(timer);fs.readFile=originalRead;if(threads.Worker===TracedWorker)threads.Worker=OriginalWorker;if(ipcMain._invokeHandlers.get('rivu:image-bytes')===wrapped){ipcMain.removeHandler('rivu:image-bytes');ipcMain.handle('rivu:image-bytes',original);}};
 },imagePath);
}

// Appended to a test-only extra preload after contextBridge/ipcRenderer are imported.
export const preloadByteStageSource=String.raw`
const stageRows=[],stageInvoke=ipcRenderer.invoke.bind(ipcRenderer);
const stageMark=(id,edge)=>{const name='rivu-byte:'+id+':preload-invoke:'+edge;performance.mark(name);performance.clearMarks(name);};
ipcRenderer.invoke=async function(channel,...args){
 if(channel!=='rivu:image-bytes')return stageInvoke(channel,...args);
 const id=new URL(args[0]).searchParams.get('v'),at=performance.now();let value,ok=false;
 stageMark(id,'start');
 try{value=await stageInvoke(channel,...args);ok=true;return value;}
 finally{stageMark(id,'end');if(stageRows.length<2048)stageRows.push({id,startEpochMs:performance.timeOrigin+at,ms:performance.now()-at,ok,bytes:value?.imageBytes?.byteLength??null,backingBytes:value?.imageBytes?.buffer?.byteLength??null});}
};
contextBridge.exposeInMainWorld('__byteStageTiming',{drain:()=>stageRows.splice(0)});
`;

export function installRendererByteStages(){
 const rows=[],owners=new WeakMap(),blobs=new WeakMap(),bitmaps=new WeakMap(),push=value=>{if(rows.length<4096)rows.push(value);};
 const serial=url=>new URL(url).searchParams.get('v');
 const mark=(id,phase,edge)=>{if(id){const name='rivu-byte:'+id+':'+phase+':'+edge;performance.mark(name);performance.clearMarks(name);}};
 globalThis.__byteRendererStages={rows,longTasks:[]};
 globalThis.__imageTimingApi={
  imageUrl:async(...args)=>{const at=performance.now(),url=await window.rivu.imageUrl(...args);push({id:serial(url),phase:'mint',ms:performance.now()-at});return url;},
  readImageUrl:async url=>{
   const id=serial(url),at=performance.now();let value,ok=false;mark(id,'read','start');
   try{value=await window.rivu.readImageUrl(url);if(value)owners.set(value.bytes,id);ok=true;return value;}
   finally{mark(id,'read','end');push({id,phase:'read',startEpochMs:performance.timeOrigin+at,ms:performance.now()-at,ok,bytes:value?.bytes?.byteLength??null,backingBytes:value?.bytes?.buffer?.byteLength??null});}
  },
  cancelImageUrl:async url=>{const at=performance.now();try{return await window.rivu.cancelImageUrl(url);}finally{push({id:serial(url),phase:'revoke',ms:performance.now()-at});}}
 };
 const NativeBlob=Blob,nativeBitmap=createImageBitmap.bind(window);
 window.Blob=class extends NativeBlob{
  constructor(parts,options){const at=performance.now(),id=parts?.length===1?owners.get(parts[0]):undefined;mark(id,'blob','start');super(parts,options);if(id){mark(id,'blob','end');blobs.set(this,id);push({id,phase:'blob',startEpochMs:performance.timeOrigin+at,ms:performance.now()-at,bytes:this.size});}}
 };
 window.createImageBitmap=async function(source,...args){
  const id=blobs.get(source),at=performance.now();let value,ok=false;mark(id,'bitmap','start');
  try{value=await nativeBitmap(source,...args);if(id)bitmaps.set(value,id);ok=true;return value;}
  finally{if(id){mark(id,'bitmap','end');push({id,phase:'bitmap',startEpochMs:performance.timeOrigin+at,ms:performance.now()-at,ok});}}
 };
 const prototype=ImageBitmapRenderingContext.prototype,transfer=prototype.transferFromImageBitmap;
 prototype.transferFromImageBitmap=function(bitmap){const id=bitmaps.get(bitmap),at=performance.now();mark(id,'transfer','start');try{return transfer.call(this,bitmap);}finally{if(id){mark(id,'transfer','end');push({id,phase:'transfer',startEpochMs:performance.timeOrigin+at,ms:performance.now()-at});}}};
 const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(globalThis.__byteRendererStages.longTasks.length<200)globalThis.__byteRendererStages.longTasks.push({startEpochMs:performance.timeOrigin+entry.startTime,ms:entry.duration});});
 observer.observe({entryTypes:['longtask']});globalThis.__byteRendererStages.stop=()=>observer.disconnect();
}

export async function collectByteStages(application,page){
 const main=await application.evaluate(()=>{const state=globalThis.__byteStages;state.restore();return {ipc:state.ipc,files:state.files,workers:state.workers,loop:state.loop};});
 const renderer=await page.evaluate(()=>{globalThis.__byteRendererStages.stop();return {rows:globalThis.__byteRendererStages.rows,longTasks:globalThis.__byteRendererStages.longTasks};});
 const preload=await page.evaluate(()=>window.__byteStageTiming.drain());
 return {main,renderer,preload,limits:'Diagnostic hooks perturb timings. Main CPU intervals overlap concurrent tasks. Invoke residual includes dispatch/serialization/scheduling; outer residual includes preload normalization/contextBridge handoff/scheduling, not copy CPU alone. File and worker attribution use AsyncLocalStorage; absent identity stays unattributed. Queued worker construction may inherit the draining job context, so its serial alone does not prove ownership under concurrency. Worker intervals start after constructor return.'};
}

export function summarizeByteStages(profile){
 const unique=(rows,id,label)=>{const matches=rows.filter(row=>row.id===id);if(matches.length!==1)throw Error('Missing or ambiguous '+label+' for serial'+id);return matches[0];};
 const readRows=profile.renderer.rows.filter(row=>row.phase==='read'&&row.ok);
 const rows=readRows.map(read=>{
  const id=read.id,main=unique(profile.main.ipc,id,'main IPC'),preload=unique(profile.preload,id,'preload IPC');
  const phase=name=>unique(profile.renderer.rows.filter(row=>row.phase===name),id,name).ms;
  const files=profile.main.files.filter(row=>row.id===id);
  if(files.length!==1||!files[0].ok||!main.ok||!preload.ok)throw Error('Unverified file/provider phase for serial'+id);
  const ipcResidual=preload.ms-main.ms,handoffResidual=read.ms-preload.ms;
  if(ipcResidual<-.5||handoffResidual<-.5)throw Error('Inconsistent nested timing intervals');
  return {id,startEpochMs:read.startEpochMs,readMs:read.ms,mainMs:main.ms,fileMs:files[0].ms,mainCpuMs:main.cpuMs,preloadInvokeMs:preload.ms,ipcResidualMs:ipcResidual,handoffResidualMs:handoffResidual,blobMs:phase('blob'),bitmapMs:phase('bitmap'),transferMs:phase('transfer'),mintMs:phase('mint'),revokeMs:phase('revoke')};
 });
 return {count:rows.length,slowestReads:[...rows].sort((a,b)=>b.readMs-a.readMs).slice(0,5),slowestBitmaps:[...rows].sort((a,b)=>b.bitmapMs-a.bitmapMs).slice(0,5),rows,limits:profile.limits};
}

export function inspectByteTrace(events,id,phase){
 const mark=edge=>{const found=events.filter(e=>e.name===`rivu-byte:${id}:${phase}:${edge}`);if(found.length!==1)throw Error('Missing or ambiguous byte phase mark');return found[0];};
 const start=mark('start'),end=mark('end');
 if(start.pid!==end.pid||start.tid!==end.tid||start.ts>end.ts)throw Error('Inconsistent byte phase marks');
 const overlap=e=>e.ph==='X'&&e.pid===start.pid&&e.tid===start.tid&&Number.isFinite(e.dur)&&e.dur>=0&&e.ts<end.ts&&e.ts+e.dur>start.ts;
 const gc=events.filter(e=>overlap(e)&&/^(MajorGC|MinorGC|V8\.GC)/.test(e.name||''));
 let total=0,right=-Infinity;
 for(const [from,to] of gc.map(e=>[Math.max(start.ts,e.ts),Math.min(end.ts,e.ts+e.dur)]).sort((a,b)=>a[0]-b[0])){if(to>right){total+=to-Math.max(from,right);right=to;}}
 const describe=e=>({name:e.name,durationMs:e.dur/1000,overlapMs:(Math.min(end.ts,e.ts+e.dur)-Math.max(start.ts,e.ts))/1000});
 return {id,phase,pid:start.pid,tid:start.tid,durationMs:(end.ts-start.ts)/1000,gcUnionMs:total/1000,gcSlices:gc.sort((a,b)=>b.dur-a.dur).slice(0,5).map(describe),longestTasks:events.filter(e=>overlap(e)&&e.name==='RunTask').sort((a,b)=>b.dur-a.dur).slice(0,3).map(describe)};
}
