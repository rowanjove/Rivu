import {RivuDatabase,type ReadScope} from './database';
import {markSmartFolderRead} from './smart-folders';

export type BulkReadWriteInput={databasePath:string;sessionId:string;operationId?:string}&(
 {kind:'bulk_read';scope:ReadScope&{smartFolderId?:string};token:string}|
 {kind:'bulk_read_undo';token:string;invalidated:string[]}|
 {kind:'bulk_read_cleanup'}
);
export type BulkReadWriteResult={added:0;total:number;changed:number;undoToken:string|null;expiresAt?:number};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);
const undoKey=(session:string)=>`bulk-read-undo:${session}`;
const expiryKey=(session:string)=>`bulk-read-expiry:${session}`;
export const bulkReadReceiptKey=(session:string)=>`bulk-read-receipt:${session}`;
function clearSession(db:RivuDatabase,session:string){db.db.prepare('DELETE FROM app_meta WHERE key IN (?,?,?)').run(undoKey(session),expiryKey(session),bulkReadReceiptKey(session));}
function expireSessions(db:RivuDatabase){
 const prefix='bulk-read-expiry:';
 const rows=db.db.prepare('SELECT key,value FROM app_meta WHERE key>=? AND key<?').all(prefix,prefix+'~');
 for(const row of rows){const session=String(row.key).slice(prefix.length),expires=Number(row.value);if(uuid(session)&&Number.isFinite(expires)&&expires<Date.now())clearSession(db,session);}
}
export function validBulkReadWriteResult(value:unknown):value is BulkReadWriteResult{
 const result=value as BulkReadWriteResult|undefined;
 return !!result&&Object.keys(result).every(key=>['added','total','changed','undoToken','expiresAt'].includes(key))&&result.added===0&&Number.isSafeInteger(result.changed)&&result.changed>=0&&result.total===result.changed&&
 (result.undoToken===null?result.expiresAt===undefined:uuid(result.undoToken)&&result.changed>0&&Number.isSafeInteger(result.expiresAt)&&result.expiresAt!>0);
}
export function writeBulkRead(input:BulkReadWriteInput):BulkReadWriteResult{
 if(!uuid(input.sessionId))throw Object.assign(Error('批量阅读会话无效'),{statusCode:400});
 const db=new RivuDatabase(input.databasePath,undefined,true);
 try{
  db.db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');
  try{
   if(input.kind==='bulk_read_cleanup'){clearSession(db,input.sessionId);db.db.exec('COMMIT');return {added:0,total:0,changed:0,undoToken:null};}
   expireSessions(db);
   let result:BulkReadWriteResult;
   if(input.kind==='bulk_read'){
    if(!uuid(input.token))throw Object.assign(Error('撤销令牌无效'),{statusCode:400});
    const ids=input.scope.smartFolderId?markSmartFolderRead(db,input.scope.smartFolderId,true):db.markRead(input.scope,true);
    const idsJson=JSON.stringify(ids),expiresAt=Date.now()+10*60_000;
    db.db.prepare('DELETE FROM app_meta WHERE key=?').run(undoKey(input.sessionId));
    if(ids.length)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?)').run(undoKey(input.sessionId),`{"token":${JSON.stringify(input.token)},"expiresAt":${expiresAt},"ids":${idsJson}}`);
    result={added:0,total:ids.length,changed:ids.length,undoToken:ids.length?input.token:null,...(ids.length?{expiresAt}:{})};
   }else{
    const row=db.db.prepare('SELECT value FROM app_meta WHERE key=?').get(undoKey(input.sessionId)) as {value:string}|undefined;
    if(!row)throw Object.assign(Error('撤销已失效'),{statusCode:404});
    const record=JSON.parse(row.value) as {token:string;expiresAt:number;ids:string[]};
    if(record.token!==input.token||record.expiresAt<Date.now())throw Object.assign(Error('撤销已失效'),{statusCode:404});
    if(!Array.isArray(record.ids)||record.ids.some(id=>typeof id!=='string')||!Array.isArray(input.invalidated)||input.invalidated.some(id=>typeof id!=='string'))throw Error('撤销记录无效');
    const invalidated=new Set(input.invalidated),changed=db.undoMarkRead(record.ids.filter(id=>!invalidated.has(id)),true);
    db.db.prepare('DELETE FROM app_meta WHERE key=?').run(undoKey(input.sessionId));
    result={added:0,total:changed,changed,undoToken:null};
   }
   db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(expiryKey(input.sessionId),String(Date.now()+10*60_000));
   // A small receipt is separate from potentially millions of membership bytes.
   // The main connection may recover only this receipt after a lost reply.
   if(input.operationId)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(bulkReadReceiptKey(input.sessionId),JSON.stringify({operationId:input.operationId,kind:input.kind,result}));
   db.db.exec('COMMIT');return result;
  }catch(error){if(db.db.isTransaction)db.db.exec('ROLLBACK');throw error;}
 }finally{db.close();}
}
