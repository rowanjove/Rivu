import {parentPort,workerData} from 'node:worker_threads';
void (async()=>{
 try{
  const task=require(workerData.modulePath);
  if(workerData.operation==='recover'){
   if(typeof workerData.targetDirectory!=='string'||!workerData.targetDirectory)throw Error('恢复目标目录无效');
   parentPort?.postMessage({result:await task.recoverRestoreJournal(workerData.targetDirectory,{retainFinalState:workerData.retainFinalState===true})});
  }else if(workerData.operation==='restore'){
   if(typeof workerData.targetDirectory!=='string'||!workerData.targetDirectory)throw Error('恢复目标目录无效');
   await task.restoreBackup(workerData.source,workerData.targetDirectory,{deferFinalization:true});parentPort?.postMessage({result:{restored:true}});
  }else if(workerData.operation===undefined||workerData.operation==='inspect')parentPort?.postMessage({result:await task.inspectBackup(workerData.source)});
  else throw Error('备份后台操作无效');
 }catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error)});}
 finally{parentPort?.close();}
})();
