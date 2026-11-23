export class BackupRestoreSession{
 private active=false;
 private replacing=false;
 get committing(){return this.replacing;}
 async run<T>(consume:(beginCommit:()=>void)=>Promise<T>):Promise<T>{
  if(this.active)throw Object.assign(Error('已有备份恢复任务，请等待完成'),{statusCode:409});
  this.active=true;let live=true;
  try{return await consume(()=>{if(!live)throw Error('备份恢复任务已结束');this.replacing=true;});}
  finally{live=false;this.replacing=false;this.active=false;}
 }
}
