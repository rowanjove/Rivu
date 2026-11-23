import {DatabaseSync} from 'node:sqlite';
import {archiveAsset,archivePage,archiveStats,archiveVersion,archiveVersions,getArchive,listArchives,archiveListPage,archiveHistoryPage,archiveRevision,checkArchiveRevision} from './archive-read';
export type ArchiveReadInput={databasePath:string}&(
  {kind:'stats'}|{kind:'list';limit:number;offset:number}|{kind:'list_page';limit:number;offset:number;revision?:string}|{kind:'get';archiveId:string}|{kind:'versions';archiveId:string;limit:number;offset:number}|{kind:'history_page';archiveId:string;limit:number;offset:number;revision?:string}|{kind:'version';archiveId:string;versionId:string;revision?:string}|{kind:'asset';archiveId:string;assetId:string}
);
export function readArchiveSnapshot(input:ArchiveReadInput,onSnapshot?:()=>void){
  const connection=new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
  try{
    connection.exec('PRAGMA query_only=ON; BEGIN');
    connection.prepare('SELECT 1 FROM permanent_archives LIMIT 1').get();onSnapshot?.();
    const db={db:connection};
    switch(input.kind){
      case 'stats':return archiveStats(db);
      case 'list':return listArchives(db,archivePage(input));
      case 'list_page':return archiveListPage(db,archivePage(input),input.revision);
      case 'get':return {...getArchive(db,input.archiveId,archivePage()),revision:archiveRevision(db)};
      case 'versions':return archiveVersions(db,input.archiveId,archivePage(input));
      case 'history_page':return archiveHistoryPage(db,input.archiveId,archivePage(input),input.revision);
      case 'version':if(input.revision!==undefined)checkArchiveRevision(db,input.revision);return archiveVersion(db,input.archiveId,input.versionId);
      case 'asset':{
        const size=connection.prepare('SELECT length(data) bytes FROM archive_assets WHERE archive_id=? AND id=?').get(input.archiveId,input.assetId) as {bytes:number}|undefined;
        if(size&&size.bytes>25*1024*1024)throw Object.assign(Error('归档资源超过单次读取上限，请使用独立导出'),{statusCode:413});
        const asset=archiveAsset(db,input.archiveId,input.assetId);
        return {dataUrl:`data:${asset.mime};base64,${Buffer.from(asset.data).toString('base64')}`};
      }
      default:throw Error('归档读取任务无效');
    }
  }finally{if(connection.isTransaction)connection.exec('ROLLBACK');connection.close();}
}
