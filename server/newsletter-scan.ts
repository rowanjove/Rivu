import type {RivuDatabase} from './database';
import type {NewsletterScan} from './newsletter';
export function commitNewsletterScan(db:RivuDatabase,feedId:string,scan:NewsletterScan){
  const seen=new Set(scan.files),remove=db.db.prepare('DELETE FROM newsletter_files WHERE feed_id=? AND file_name=?');
  for(const item of db.db.prepare('SELECT file_name FROM newsletter_files WHERE feed_id=?').all(feedId) as {file_name:string}[])if(!seen.has(item.file_name))remove.run(feedId,item.file_name);
  const remember=db.db.prepare('INSERT INTO newsletter_files(feed_id,file_name,modified_ms,size,failed) VALUES (?,?,?,?,?) ON CONFLICT(feed_id,file_name) DO UPDATE SET modified_ms=excluded.modified_ms,size=excluded.size,failed=excluded.failed');
  for(const record of scan.records)remember.run(feedId,record.file,record.modified,record.size,record.failed);
  if(scan.lastAudited)db.db.prepare('INSERT INTO app_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`newsletter_audit:${feedId}`,scan.lastAudited);
}

