import {parentPort,workerData} from 'node:worker_threads';
const {readEntrySnapshot,EntryJsonCache,EntryReadConnection}=require(workerData.modulePath);
const jsonCache=typeof EntryJsonCache==='function'?new EntryJsonCache():undefined;
const reader=typeof EntryReadConnection==='function'?new EntryReadConnection(workerData.pageCacheKiB??2048):undefined;
parentPort?.on('message',input=>{
  try{
    if(input.kind==='close_entry_reader'){reader?.close();parentPort?.postMessage({result:null});return;}
    const result=readEntrySnapshot(input,undefined,jsonCache,reader);
    if(input.kind==='entry'&&input.serialize&&result?.json instanceof ArrayBuffer){
      parentPort?.postMessage({result},[result.json]);
    }
    else if(input.kind==='entry'&&input.serialize&&result!==undefined&&result!==null){
      const json=new TextEncoder().encode(JSON.stringify(result));
      parentPort?.postMessage({result:{json:json.buffer}},[json.buffer]);
    }else parentPort?.postMessage({result});
  }
  catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number}).statusCode});}
});
