import {Worker} from 'node:worker_threads';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertBackupSpace,regularFileSize} from '../shared/backup-space';

// Both the displayed preflight and the confirmed restore consume this private
// copy, even if the original file is replaced while the dialog is open.
export async function withBackupSnapshot<T>(source:string,consume:(snapshot:string)=>Promise<T>):Promise<T>{
 const sourceBytes=await regularFileSize(source);
 const directory=await mkdtemp(join(tmpdir(),'rivu-selected-backup-'));
 try{
  await assertBackupSpace({tempDirectory:directory,sourceBytes,totalUncompressedBytes:0});
  const snapshot=join(directory,'selected.zip');await copyFile(source,snapshot);return await consume(snapshot);
 }
 // A cleanup error must not mask restoration failure or prevent relaunch after
 // a successful database replacement.
 finally{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{console.warn('备份临时副本清理失败');});}
}

type RecoveryInfo={recovered:boolean;outcome?:string};
type BackupInfo={schemaVersion:number;hasSettings:boolean;includesSecrets:boolean};
// Callers must stop the service and close its database before requesting restore.
async function runBackupWorker(workerPath:string,modulePath:string,source:string,targetDirectory?:string,recover=false,retainFinalState=false):Promise<BackupInfo|{restored:true}|RecoveryInfo>{
 const worker=new Worker(workerPath,{workerData:{modulePath,source,retainFinalState,operation:recover?'recover':targetDirectory===undefined?'inspect':'restore',targetDirectory},resourceLimits:{maxOldGenerationSizeMb:256}});
 try{return await new Promise<BackupInfo|{restored:true}|RecoveryInfo>((resolve,reject)=>{
  let settled=false;
  worker.on('message',message=>{
   if(settled)return;
   settled=true;
   if(message?.error)reject(Error(message.error));
   else if(recover&&typeof message?.result?.recovered==='boolean'&&(!message.result.recovered||['committed','rolled-back'].includes(message.result.outcome)))resolve(message.result);
   else if(!recover&&targetDirectory!==undefined&&message?.result?.restored===true)resolve({restored:true});
   else if(targetDirectory===undefined&&message?.result&&Number.isInteger(message.result.schemaVersion)&&typeof message.result.hasSettings==='boolean'&&typeof message.result.includesSecrets==='boolean')resolve(message.result);
   else reject(Error('备份后台结果无效'));
  });
  worker.on('error',error=>{if(!settled){settled=true;reject(error);}});
  worker.on('exit',code=>{if(!settled){settled=true;reject(Error(`备份后台进程退出（${code}）`));}});
 });}finally{await worker.terminate();}
}

export async function inspectBackupInWorker(workerPath:string,modulePath:string,source:string):Promise<BackupInfo>{
 return await runBackupWorker(workerPath,modulePath,source) as BackupInfo;
}
export async function restoreBackupInWorker(workerPath:string,modulePath:string,source:string,targetDirectory:string):Promise<void>{
 try{await runBackupWorker(workerPath,modulePath,source,targetDirectory);}
 catch(error){
  let recovery:RecoveryInfo;
  try{recovery=await runBackupWorker(workerPath,modulePath,'',targetDirectory,true,true) as RecoveryInfo;}
  catch(recoveryError){throw new AggregateError([error,recoveryError],`${error instanceof Error?error.message:String(error)}；恢复状态无法确认，请保留现场`);}
  if(recovery.outcome!=='committed')throw error;
 }
 // Success is already known. A failed cleanup must not turn committed data
 // into a failure report; the next startup can repeat journal cleanup.
 await recoverRestoreInWorker(workerPath,modulePath,targetDirectory).catch(()=>console.warn('恢复已提交，日志清理将在下次启动重试'));
}

export async function recoverRestoreInWorker(workerPath:string,modulePath:string,targetDirectory:string):Promise<RecoveryInfo>{
 return await runBackupWorker(workerPath,modulePath,'',targetDirectory,true) as RecoveryInfo;
}
