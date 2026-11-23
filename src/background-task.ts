// Explicit background priority avoids inheriting a click's continuation priority
// and starving normal timers while a long article is being prepared.
export async function yieldBackgroundTask(signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  const scheduler=(globalThis as typeof globalThis&{scheduler?:{postTask:(callback:()=>void,options:{priority:'background';signal?:AbortSignal})=>Promise<unknown>}}).scheduler;
  if(scheduler?.postTask)await scheduler.postTask(()=>{},{priority:'background',signal});
  else await new Promise<void>((resolve,reject)=>{
    const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,0);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason);};
    signal?.addEventListener('abort',abort,{once:true});
  });
  signal?.throwIfAborted();
}
