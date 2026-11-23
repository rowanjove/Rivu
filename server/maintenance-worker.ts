import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pairTokens } from './search-pairs';
import {sourceIconKey} from './source-icons';
import {validateUnreadCounts} from './unread-counts';
import {validateRawUnreadProjection} from './raw-unread-projection';
import {validateSearchRowidProjection} from './search-rowid-projection';
import {validateStableStorageKeys} from './stable-storage';

type Input={databasePath:string;imageDirectory:string};
const {databasePath,imageDirectory}=workerData as Input;
const db=new DatabaseSync(databasePath,{timeout:10000});
db.function('rivu_pairs',{deterministic:true,varargs:true},pairTokens);
const validFile=/^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/;
const send=(phase:string)=>parentPort?.postMessage({phase});
try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
  send('cache');
  const rows=db.prepare('SELECT url,file_name,bytes FROM cached_images').all() as {url:string;file_name:string;bytes:number}[];
  const remove=db.prepare('DELETE FROM cached_images WHERE url=? AND file_name=?');
  let removedCacheRows=0;
  for(const row of rows){
    let valid=validFile.test(row.file_name);
    if(valid)try{const info=statSync(join(imageDirectory,row.file_name));valid=info.isFile()&&info.size===row.bytes;}catch{valid=false;}
    if(!valid)removedCacheRows+=Number(remove.run(row.url,row.file_name).changes);
  }
  db.exec('BEGIN');
  try{
    db.exec('DELETE FROM feed_icon_keys');
    const insert=db.prepare('INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?)');
    for(const row of db.prepare('SELECT id,icon FROM feeds').iterate())insert.run(row.id,sourceIconKey(row.icon));
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  send('fts');
  db.exec('BEGIN');
  try{
    db.exec("INSERT INTO entry_fts(entry_fts) VALUES('delete-all')");
    db.exec('INSERT INTO entry_fts(rowid,title,content,description,author) SELECT rowid,title,COALESCE(full_content,content),description,author FROM entries');
    db.exec("INSERT INTO ai_result_fts(ai_result_fts) VALUES('rebuild')");
    db.exec('DELETE FROM entry_pair_fts; DELETE FROM ai_result_pair_fts');
    db.exec('INSERT INTO entry_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(title,content,description,author,full_content) FROM entries');
    db.exec('INSERT INTO ai_result_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(content) FROM ai_results');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  send('vacuum');
  db.exec('VACUUM');
  send('integrity');
  const integrity=db.prepare('PRAGMA integrity_check').get() as {integrity_check:string};
  if(integrity.integrity_check!=='ok')throw Error('数据库优化后完整性校验失败');
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('数据库优化后存在失效的关联记录');
  validateUnreadCounts(db);
  validateRawUnreadProjection(db);
  validateStableStorageKeys(db);validateSearchRowidProjection(db);
  parentPort?.postMessage({done:true,removedCacheRows});
}catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error)});}
finally{db.close();}
