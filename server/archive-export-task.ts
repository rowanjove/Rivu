import {DatabaseSync} from 'node:sqlite';
import {exportArchive} from './archive';
import type {RivuDatabase} from './database';

export type ArchiveExportInput={databasePath:string;archiveId:string;destination:string;temporaryPath:string};
export async function exportArchiveSnapshot(input:ArchiveExportInput,onSnapshot?:()=>void){
  const connection=new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
  try{
    connection.exec('PRAGMA query_only=ON; BEGIN');
    if(!connection.prepare('SELECT 1 FROM permanent_archives WHERE id=?').get(input.archiveId))throw Object.assign(Error('永久归档不存在'),{statusCode:404});
    onSnapshot?.();
    // exportArchive only uses db.db. Keep a read transaction through lazy ZIP reads.
    return await exportArchive({db:connection} as RivuDatabase,input.archiveId,input.destination,input.temporaryPath);
  }finally{
    if(connection.isTransaction)connection.exec('ROLLBACK');
    connection.close();
  }
}
