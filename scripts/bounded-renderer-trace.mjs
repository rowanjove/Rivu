// CDP TraceConfig: https://chromedevtools.github.io/devtools-protocol/tot/Tracing/#type-TraceConfig
// Keep the runtime ring small; retain only bounded numeric GC counters, no string arguments or raw trace.
function numericCounters(args){
 const result={};
 for(const [key,value] of Object.entries(args??{}).slice(0,16)){
  if(typeof value==='number'&&Number.isFinite(value))result[key]=value;
  else if(value&&typeof value==='object'&&!Array.isArray(value))for(const [child,number] of Object.entries(value).slice(0,16))if(typeof number==='number'&&Number.isFinite(number))result[`${key}.${child}`]=number;
  if(Object.keys(result).length>=32)break;
 }
 return Object.fromEntries(Object.entries(result).slice(0,32));
}
export async function startBoundedRendererTrace(page){
 const session=await page.context().newCDPSession(page),events=[],threads=new Map();
 const heap=async()=>{try{const value=await session.send('Runtime.getHeapUsage');return Object.fromEntries(['usedSize','totalSize','embedderHeapUsedSize','backingStorageSize'].filter(key=>typeof value[key]==='number').map(key=>[key,value[key]]));}catch{return null;}};
 let heapBefore,categories;
 let received=0,discarded=0;
 session.on('Tracing.dataCollected',({value})=>{
  for(const event of value){
   received++;
   if(event.ph==='M'&&event.name==='thread_name')threads.set(`${event.pid}:${event.tid}`,String(event.args?.name??'').slice(0,128));
   if(!['X','B','E'].includes(event.ph)&&!/^rivu-writer-(round|gap)-/.test(event.name??''))continue;
   if(events.length>=50000){discarded++;continue;}
   events.push({name:String(event.name??'').slice(0,160),ph:event.ph,ts:event.ts,dur:event.dur,pid:event.pid,tid:event.tid,...(/gc|garbage/i.test(event.name??'')?{numericArgs:numericCounters(event.args)}:{})});
  }
 });
 try{
  heapBefore=await heap();
  const available=await session.send('Tracing.getCategories');
  categories=['devtools.timeline','v8','blink_gc','blink.user_timing',...(available.categories??['disabled-by-default-v8.gc','disabled-by-default-blink_gc']).filter(name=>/^(disabled-by-default-v8\.gc|disabled-by-default-blink_gc)$/.test(name)).slice(0,16)];
  await session.send('Tracing.start',{transferMode:'ReportEvents',traceConfig:{recordMode:'recordContinuously',traceBufferSizeInKb:2048,includedCategories:categories}});
 }
 catch(error){await session.detach();throw error;}
 return async()=>{
  try{
   const heapAfter=await heap();let timeout;
   const complete=new Promise((resolve,reject)=>{session.once('Tracing.tracingComplete',resolve);timeout=setTimeout(()=>reject(Error('Bounded trace completion timeout')),15000);});
   let completion;
   try{await session.send('Tracing.end');completion=await complete;}finally{clearTimeout(timeout);}
   const spans=[],stacks=new Map();
   for(const event of events.sort((a,b)=>a.ts-b.ts)){
    const key=`${event.pid}:${event.tid}`;
    if(event.ph==='X'&&Number.isFinite(event.dur))spans.push(event);
    else if(event.ph==='B'){const stack=stacks.get(key)??[];stack.push(event);stacks.set(key,stack);}
    else if(event.ph==='E'){const begin=stacks.get(key)?.pop();if(begin)spans.push({...begin,dur:event.ts-begin.ts});}
   }
   const describe=event=>({name:event.name,phase:event.ph,ms:event.dur/1000,startUs:event.ts,pid:event.pid,tid:event.tid,thread:threads.get(`${event.pid}:${event.tid}`)??null,...(event.numericArgs?{numericArgs:event.numericArgs}:{})});
   const marks=events.filter(event=>/^rivu-writer-(round|gap)-/.test(event.name));
   const gaps=marks.filter(event=>/^rivu-writer-gap-\d+-\d+$/.test(event.name)).map(mark=>{
    const ms=Number(mark.name.split('-').at(-1)),begin=mark.ts-ms*1000;
    return {name:mark.name,ms,endUs:mark.ts,pid:mark.pid,tid:mark.tid,overlaps:spans.filter(event=>event.pid===mark.pid&&event.tid===mark.tid&&event.ts<mark.ts&&event.ts+event.dur>begin&&event.dur>=20000).sort((a,b)=>b.dur-a.dur).slice(0,12).map(describe)};
   });
   return {diagnostic:true,ringKiB:2048,categories,heapBefore,heapAfter,received,retained:events.length,discarded,dataLossOccurred:completion.dataLossOccurred??null,scope:'Runtime ring may overwrite old events. String arguments and raw trace are discarded; absent events do not prove absence of work. B/E reconstruction can be incomplete when events were lost; inspect phase before attribution.',marks:marks.slice(0,40),gaps:gaps.sort((a,b)=>b.ms-a.ms).slice(0,12),gcPhases:spans.filter(event=>/gc|garbage/i.test(event.name)).sort((a,b)=>b.dur-a.dur).slice(0,40).map(describe),longestSpans:spans.sort((a,b)=>b.dur-a.dur).slice(0,40).map(describe)};
  }finally{await session.detach();}
 };
}
