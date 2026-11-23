import {beginRestoreJournal,markRestoreCommitted,recoverRestoreJournal} from './restore-journal';
import yazl from 'yazl';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DatabaseSync, backup } from 'node:sqlite';
import { RivuDatabase, SCHEMA_VERSION } from './database';
import {validateUnreadCounts} from './unread-counts';
import {validateRawUnreadProjection} from './raw-unread-projection';
import {validateSearchRowidProjection} from './search-rowid-projection';
import { validateReadingSettings } from './reading-settings';
import { validateProxyPreferences } from './proxy-settings';
import { assertBackupSpace, BACKUP_ENTRY_LIMITS, SQLITE_MIGRATION_RESERVE, regularFileSize, validateBackupEntries } from '../shared/backup-space';

type BackupInfo = { schemaVersion:number; hasSettings:boolean; includesSecrets:boolean };
type Manifest={format?:string;version?:number;schemaVersion?:number};

function validateManifest(manifest:Manifest){
  if(manifest.format!=='rivu-backup'||![1,2].includes(Number(manifest.version)))throw Error('不支持此备份版本');
  if(manifest.schemaVersion!==undefined&&(!Number.isInteger(manifest.schemaVersion)||manifest.schemaVersion>SCHEMA_VERSION||manifest.schemaVersion<0))throw Error('备份数据库版本不受支持');
}

async function readZipEntry(zip:ZipFile,entry:Entry){
  const stream=await zip.openReadStreamPromise(entry);
  const chunks:Buffer[]=[];
  for await(const chunk of stream)chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type ExtractOptions={targetDirectory?:string;currentDbBytes?:number;currentSettingsBytes?:number};
async function extractBackup(source:string,directory:string,options:ExtractOptions={}){
  await regularFileSize(source);
  await mkdir(directory,{recursive:true});
  const zip=await yauzl.openPromise(source,{strictFileNames:true,validateEntrySizes:true});
  try{
    const entries:Entry[]=[],names=new Set<string>();
    let manifestBytes:Buffer|undefined;
    for await(const entry of zip.eachEntry()){
      const limit=BACKUP_ENTRY_LIMITS[entry.fileName as keyof typeof BACKUP_ENTRY_LIMITS];
      if(entries.length>=3||!Object.hasOwn(BACKUP_ENTRY_LIMITS,entry.fileName)||names.has(entry.fileName)||!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>limit)throw Error('备份含无效、重复或超出大小限制的文件');
      names.add(entry.fileName);
      entries.push(entry);
      // yauzl's async iterator closes the archive after the final entry, so
      // capture the tiny manifest while the ZipFile is still open.
      if(entry.fileName==='manifest.json'&&entry.uncompressedSize<=BACKUP_ENTRY_LIMITS['manifest.json'])manifestBytes=await readZipEntry(zip,entry);
    }
    const {totalUncompressedBytes,seen}=validateBackupEntries(entries);
    const manifest=JSON.parse(manifestBytes!.toString('utf8')) as Manifest;
    validateManifest(manifest);
    const dbEntry=entries.find(entry=>entry.fileName==='rivu.db')!;
    // RivuDatabase.open reserves (db * 4) + 1 GiB for migration snapshots
    // when the archive declares an older schema. New/current archives do not
    // pay this reserve, preserving compatibility with large current databases.
    const migrationBytes=manifest.schemaVersion!==undefined&&manifest.schemaVersion<SCHEMA_VERSION
      ? dbEntry.uncompressedSize*4+SQLITE_MIGRATION_RESERVE : 0;
    await assertBackupSpace({
      tempDirectory:directory,
      targetDirectory:options.targetDirectory,
      totalUncompressedBytes,
      currentDbBytes:options.currentDbBytes,
      currentSettingsBytes:options.currentSettingsBytes,
      migrationBytes,
    });
    const writeZip=await yauzl.openPromise(source,{strictFileNames:true,validateEntrySizes:true});
    try{
      const validated=new Map(entries.map(entry=>[entry.fileName,`${entry.uncompressedSize}:${entry.compressedSize}:${entry.crc32}`]));
      const written=new Set<string>();
      for await(const entry of writeZip.eachEntry()){
        if(!validated.has(entry.fileName)||written.has(entry.fileName)||validated.get(entry.fileName)!==`${entry.uncompressedSize}:${entry.compressedSize}:${entry.crc32}`)throw Error('备份在读取期间发生变化');
        written.add(entry.fileName);
        await pipeline(await writeZip.openReadStreamPromise(entry),createWriteStream(join(directory,entry.fileName),{flags:'wx'}));
      }
      if(written.size!==validated.size)throw Error('备份在读取期间发生变化');
    }finally{writeZip.close();}
    let settingsData:Record<string,unknown>|undefined;
    if(seen.has('settings.json')){
      const parsed:unknown=JSON.parse(await readFile(join(directory,'settings.json'),'utf8'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('备份设置无效');
      settingsData=parsed as Record<string,unknown>;
      if(settingsData.reading!==undefined)validateReadingSettings(settingsData.reading);
      if(settingsData.proxy!==undefined)validateProxyPreferences(settingsData.proxy);
    }
    return {databasePath:join(directory,'rivu.db'),settingsData,manifest};
  }finally{zip.close();}
}

async function validateExtractedBackup(contents:Awaited<ReturnType<typeof extractBackup>>):Promise<BackupInfo>{
    const db=new DatabaseSync(contents.databasePath,{readOnly:true});
    let result:BackupInfo;
    try{
      const integrity=db.prepare('PRAGMA integrity_check').get() as {integrity_check:string};
      if(integrity.integrity_check!=='ok')throw Error('备份数据库损坏');
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('备份数据库存在失效的关联记录');
      const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      if(version>SCHEMA_VERSION)throw Error(`备份数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}`);
      if(contents.manifest.schemaVersion!==undefined&&contents.manifest.schemaVersion!==version)throw Error('备份清单与数据库版本不一致');
      const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('feeds','entries','categories')").all() as {name:string}[];
      if(tables.length!==3)throw Error('备份缺少必要的数据表');
      const ai=contents.settingsData?.ai;
      result={schemaVersion:version,hasSettings:!!contents.settingsData,includesSecrets:!!(ai&&typeof ai==='object'&&'apiKey' in ai&&(ai as {apiKey?:unknown}).apiKey)};
    }finally{db.close();}
    let upgraded:RivuDatabase;
    try{upgraded=await RivuDatabase.open(contents.databasePath);}catch(error){if(error instanceof Error&&/no such (column|table)/i.test(error.message))throw new Error('备份数据库结构不完整',{cause:error});throw error;}
    try{validateUnreadCounts(upgraded.db);validateRawUnreadProjection(upgraded.db);validateSearchRowidProjection(upgraded.db);upgraded.feeds();upgraded.entries({limit:1});}finally{upgraded.close();}
    return result;
}

export async function inspectBackup(source:string):Promise<BackupInfo>{
  const directory=await mkdtemp(join(tmpdir(),'rivu-backup-check-'));
  try{return await validateExtractedBackup(await extractBackup(source,directory));}
  finally{await rm(directory,{recursive:true,force:true});}
}

async function existingFileBytes(path:string){
  try{
    const info=await stat(path);
    return info.isFile()&&Number.isSafeInteger(info.size)&&info.size>0?info.size:0;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;
    throw error;
  }
}

export async function createBackup(db:RivuDatabase,dataDir:string,dest:string,options:{includeSecrets?:boolean;onSnapshotProgress?:(percent:number)=>void}={}){
  const snapshot=join(dataDir,`backup-${randomUUID()}.db`),temp=`${dest}.${randomUUID()}.tmp`;
  try{
    await backup(db.db,snapshot,{rate:4096,progress:({totalPages,remainingPages})=>{if(totalPages>0)options.onSnapshotProgress?.(Math.min(100,Math.floor((totalPages-remainingPages)*100/totalPages)));}});
    options.onSnapshotProgress?.(100);
    const zip=new yazl.ZipFile(),output=zip.outputStream as Readable;
    zip.on('error',error=>output.destroy(error));
    const completion=pipeline(output,createWriteStream(temp));completion.catch(()=>{});
    try{
      zip.addFile(snapshot,'rivu.db');
      let hasSettings=false;
      try{
        const settings=JSON.parse(await readFile(join(dataDir,'settings.json'),'utf8')) as Record<string,unknown>;
        if(!settings||typeof settings!=='object'||Array.isArray(settings))throw Error('本地设置格式无效');
        if(!options.includeSecrets&&settings.ai&&typeof settings.ai==='object'){
          settings.ai={...(settings.ai as Record<string,unknown>)};
          delete (settings.ai as Record<string,unknown>).apiKey;
          delete (settings.ai as Record<string,unknown>).credentialId;
        }
        if(settings.proxy!==undefined){
          try{settings.proxy=validateProxyPreferences(settings.proxy);}
          catch{delete settings.proxy;}
        }
        if(settings.reading!==undefined){
          try{validateReadingSettings(settings.reading);}
          catch{delete settings.reading;}
        }
        zip.addBuffer(Buffer.from(JSON.stringify(settings)),'settings.json');hasSettings=true;
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      zip.addBuffer(Buffer.from(JSON.stringify({format:'rivu-backup',version:2,schemaVersion:SCHEMA_VERSION,createdAt:new Date().toISOString(),hasSettings,includesSecrets:!!options.includeSecrets})),'manifest.json');
      zip.end();await completion;await rename(temp,dest);return dest;
    }catch(error){output.destroy(error as Error);await completion.catch(()=>{});throw error;}
  }finally{await rm(snapshot,{force:true});await rm(temp,{force:true});}
}

export async function restoreBackup(source:string,dataDir:string,options:{deferFinalization?:boolean}={}){
  const startedAt=Date.now();
  await mkdir(dataDir,{recursive:true});
  await recoverRestoreJournal(dataDir);
  const id=randomUUID(),tempDir=join(dataDir,`restore-${id}`);
  const currentDb=join(dataDir,'rivu.db'),currentSettings=join(dataDir,'settings.json');
  const rollbackDb=join(dataDir,`before-restore-${id}.db`),rollbackSettings=join(dataDir,`before-restore-${id}.json`);
  let hadDb=false,hadSettings=false,journalAttempted=false,safeToClean=true;
  try{
    const [currentDbBytes,currentSettingsBytes]=await Promise.all([existingFileBytes(currentDb),existingFileBytes(currentSettings)]);
    const contents=await extractBackup(source,tempDir,{targetDirectory:dataDir,currentDbBytes,currentSettingsBytes});
    const info=await validateExtractedBackup(contents);
    const restoredDb=new DatabaseSync(contents.databasePath);
    try{restoredDb.prepare("UPDATE feeds SET folder_authorized=0 WHERE type='newsletter'").run();}finally{restoredDb.close();}
    try{await stat(currentDb);hadDb=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{await stat(currentSettings);hadSettings=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(hadDb)await copyFile(currentDb,rollbackDb);
    if(contents.settingsData&&hadSettings)await copyFile(currentSettings,rollbackSettings);
    journalAttempted=true;safeToClean=false;
    await beginRestoreJournal(dataDir,id,{hadDb,hadSettings,replaceSettings:!!contents.settingsData});
    await rename(contents.databasePath,currentDb);
    if(contents.settingsData)await rename(join(tempDir,'settings.json'),currentSettings);
    await markRestoreCommitted(dataDir);
    if(!options.deferFinalization){await recoverRestoreJournal(dataDir);safeToClean=true;}
    const durationMs=Date.now()-startedAt;
    try{await writeFile(join(dataDir,'restore-report.json'),JSON.stringify({completedAt:new Date().toISOString(),durationMs,backupBytes:(await stat(source)).size}));}catch{/* Restore succeeds even if its optional report cannot be written. */}
    return {restored:true,durationMs,includesSecrets:info.includesSecrets};
  }catch(error){
    if(journalAttempted){
      try{await recoverRestoreJournal(dataDir);safeToClean=true;}
      catch(recoveryError){throw new AggregateError([error,recoveryError],'恢复失败，自动恢复未完成；请保留恢复日志与原数据副本');}
    }
    throw error;
  }finally{
    await rm(tempDir,{recursive:true,force:true});
    if(safeToClean){await rm(rollbackDb,{force:true});await rm(rollbackSettings,{force:true});}
  }
}
