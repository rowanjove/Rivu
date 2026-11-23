import {open,readFile,rename,copyFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';

type Journal={version:1;id:string;phase:'prepared'|'committed'|'rolled-back';hadDb:boolean;hadSettings:boolean;replaceSettings:boolean};
const name='restore-journal.json';
async function regular(path:string,optional=false){
 try{const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw Error('恢复日志文件类型无效');return true;}
 catch(error){if(optional&&(error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
function parse(raw:string):Journal{
 const value=JSON.parse(raw);
 if(!value||value.version!==1||typeof value.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)||!['prepared','committed','rolled-back'].includes(value.phase)||['hadDb','hadSettings','replaceSettings'].some(key=>typeof value[key]!=='boolean'))throw Error('恢复日志无效，请保留现场');
 return value;
}
async function load(directory:string){const path=join(directory,name);if(!await regular(path,true))return null;return parse(await readFile(path,'utf8'));}
async function write(directory:string,journal:Journal,initial=false){
 const path=join(directory,initial?name:`restore-journal-${journal.id}.tmp`);
 if(!initial){await regular(path,true);await rm(path,{force:true});}
 const file=await open(path,'wx');
 try{await file.writeFile(JSON.stringify(journal));await file.sync();}finally{await file.close();}
 if(!initial)await rename(path,join(directory,name));
}
function rollbackPaths(directory:string,journal:Journal){return {db:join(directory,`before-restore-${journal.id}.db`),settings:join(directory,`before-restore-${journal.id}.json`)};}
async function syncFile(path:string){await regular(path);const file=await open(path,'r+');try{await file.sync();}finally{await file.close();}}

// Call only after complete rollback copies exist and before replacing either file.
export async function beginRestoreJournal(directory:string,id:string,options:{hadDb:boolean;hadSettings:boolean;replaceSettings:boolean}){
 const journal=parse(JSON.stringify({version:1,id,phase:'prepared',...options})),paths=rollbackPaths(directory,journal);
 if(journal.hadDb)await syncFile(paths.db);if(journal.replaceSettings&&journal.hadSettings)await syncFile(paths.settings);
 await write(directory,journal,true);
}
export async function markRestoreCommitted(directory:string){
 const journal=await load(directory);if(!journal||journal.phase!=='prepared')throw Error('恢复提交日志状态无效');
 for(const path of [join(directory,'rivu.db'),...(journal.replaceSettings?[join(directory,'settings.json')]:[])])await syncFile(path);
 await write(directory,{...journal,phase:'committed'});
}
async function replaceFromCopy(source:string,target:string,temp:string){
 await regular(source);await regular(target,true);await regular(temp,true);
 await copyFile(source,temp);const file=await open(temp,'r+');try{await file.sync();}finally{await file.close();}await rename(temp,target);
}

// Must complete before opening/migrating the live database or starting services.
// A prepared transaction always restores the old pair; repeat recovery is safe.
export async function recoverRestoreJournal(directory:string,options:{retainFinalState?:boolean}={}){
 const journal=await load(directory);if(!journal)return {recovered:false};
 const paths=rollbackPaths(directory,journal),db=join(directory,'rivu.db'),settings=join(directory,'settings.json');
 if(journal.phase==='prepared'){
  // Validate all required evidence before touching either member of the pair.
  if(journal.hadDb)await regular(paths.db);if(journal.replaceSettings&&journal.hadSettings)await regular(paths.settings);
  if(journal.hadDb)await replaceFromCopy(paths.db,db,join(directory,`restore-recover-${journal.id}.db`));else{await regular(db,true);await rm(db,{force:true});}
  if(journal.replaceSettings){if(journal.hadSettings)await replaceFromCopy(paths.settings,settings,join(directory,`restore-recover-${journal.id}.json`));else{await regular(settings,true);await rm(settings,{force:true});}}
  await write(directory,{...journal,phase:'rolled-back'});
 }
 if(options.retainFinalState)return {recovered:true,outcome:journal.phase==='committed'?'committed':'rolled-back'};
 // Once a final state is recorded, interruption during cleanup is repeatable.
 for(const path of [paths.db,paths.settings,join(directory,`restore-journal-${journal.id}.tmp`)]){await regular(path,true);await rm(path,{force:true});}
 await rm(join(directory,name));return {recovered:true,outcome:journal.phase==='committed'?'committed':'rolled-back'};
}
