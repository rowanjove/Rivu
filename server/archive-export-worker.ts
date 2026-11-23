import {parentPort,workerData} from 'node:worker_threads';

void(async()=>{
  try{
    const {exportArchiveSnapshot}=require(workerData.modulePath);
    const result=await exportArchiveSnapshot(workerData.input,()=>parentPort?.postMessage({phase:'snapshot'}));
    parentPort?.postMessage({result});
  }catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number})?.statusCode});}
})();
