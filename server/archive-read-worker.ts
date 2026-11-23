import {parentPort,workerData} from 'node:worker_threads';
const {readArchiveSnapshot}=require(workerData.modulePath);
parentPort?.on('message',input=>{
  try{parentPort?.postMessage({result:readArchiveSnapshot(input)});}
  catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number}).statusCode});}
});
