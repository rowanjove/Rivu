import type {RivuDatabase} from './database';
type Database=Pick<RivuDatabase,'db'>;
type Archive={id:string;source_entry_id:string;feed_id:string;feed_title:string;title:string;url:string|null;created_at:string;updated_at:string};
type Page={limit:number;offset:number};
const bad=(message:string,statusCode=400)=>Object.assign(Error(message),{statusCode});
export function archivePage(raw:{limit?:unknown;offset?:unknown}={}):Page{
  const number=(value:unknown,fallback:number)=>value===undefined?fallback:typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN;
  const limit=number(raw.limit,100),offset=number(raw.offset,0);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw bad('归档分页参数无效');
  return {limit,offset};
}
export function archiveRevision(db:Database){
  const row=db.db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get() as {value:string}|undefined;
  if(!row||!/^\d{1,19}$/.test(row.value))throw bad('归档修订记录无效',500);
  return row.value;
}
export function validateArchiveRevision(value:unknown):string|undefined{
  if(value===undefined)return undefined;
  if(typeof value!=='string'||!/^\d{1,19}$/.test(value))throw bad('归档分页范围标识无效');
  return value;
}
export function checkArchiveRevision(db:Database,expected?:string){
  const revision=archiveRevision(db);
  if(expected!==undefined&&expected!==revision)throw bad('归档内容已变化，请刷新列表或重新打开归档',409);
  return revision;
}
export function archiveListPage(db:Database,page:Page,expected?:string){
  if(page.offset>0&&expected===undefined)throw bad('翻页必须携带归档范围标识');
  const revision=checkArchiveRevision(db,expected),rows=listArchives(db,{...page,limit:page.limit+1}),stats=archiveStats(db);
  return {items:rows.slice(0,page.limit),hasNext:rows.length>page.limit,total:stats.count,stats,revision};
}
export function archiveHistoryPage(db:Database,id:string,page:Page,expected?:string){
  if(page.offset>0&&expected===undefined)throw bad('翻页必须携带归档范围标识');
  const revision=checkArchiveRevision(db,expected),rows=archiveVersions(db,id,{...page,limit:page.limit+1});
  const total=Number((db.db.prepare('SELECT count(*) n FROM archive_versions WHERE archive_id=?').get(id) as {n:number}).n);
  return {items:rows.slice(0,page.limit),hasNext:rows.length>page.limit,total,revision};
}
export function archiveStats(db:Database){
  const assets=db.db.prepare('SELECT count(*) count,COALESCE(sum(bytes),0) bytes FROM archive_assets').get() as {count:number;bytes:number};
  // octet_length reads the stored byte count without loading overflow text pages.
  const bodies=db.db.prepare('SELECT COALESCE(sum(octet_length(body_html)),0) bytes FROM archive_versions').get() as {bytes:number};
  const count=db.db.prepare('SELECT count(*) count FROM permanent_archives').get() as {count:number};
  return {count:count.count,assets:assets.count,bytes:assets.bytes+bodies.bytes,quotaBytes:1024*1024*1024};
}
export function listArchives(db:Database,page?:Page){
  return db.db.prepare(`SELECT p.*,v.id version_id,v.created_at version_at,(SELECT count(*) FROM archive_versions WHERE archive_id=p.id) version_count,(SELECT count(*) FROM archive_assets WHERE version_id=v.id) asset_count FROM permanent_archives p JOIN archive_versions v ON v.id=(SELECT id FROM archive_versions WHERE archive_id=p.id ORDER BY created_at DESC,rowid DESC LIMIT 1) ORDER BY p.updated_at DESC,p.id DESC${page?' LIMIT ? OFFSET ?':''}`).all(...(page?[page.limit,page.offset]:[]));
}
export function archiveVersions(db:Database,id:string,page?:Page){
  if(!db.db.prepare('SELECT 1 FROM permanent_archives WHERE id=?').get(id))throw bad('永久归档不存在',404);
  return db.db.prepare(`SELECT id,content_hash,created_at FROM archive_versions WHERE archive_id=? ORDER BY created_at DESC,rowid DESC${page?' LIMIT ? OFFSET ?':''}`).all(id,...(page?[page.limit,page.offset]:[]));
}
export function getArchive(db:Database,id:string,page?:Page){
  const record=db.db.prepare('SELECT * FROM permanent_archives WHERE id=?').get(id) as Archive|undefined;
  if(!record)throw bad('永久归档不存在',404);
  const versions=archiveVersions(db,id,page);
  // Select the identity before loading HTML: tied timestamps must not sort bodies.
  const latest=db.db.prepare('SELECT id,body_html FROM archive_versions WHERE id=(SELECT id FROM archive_versions WHERE archive_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)').get(id) as {id:string;body_html:string}|undefined;
  if(!latest)throw bad('归档没有可读正文',404);
  const assets=db.db.prepare('SELECT id,kind,url,mime,bytes FROM archive_assets WHERE version_id=? ORDER BY kind,url').all(latest.id);
  const count=db.db.prepare('SELECT count(*) n FROM archive_versions WHERE archive_id=?').get(id) as {n:number};
  return {...record,body_html:latest.body_html,version_id:latest.id,version_count:count.n,versions,assets};
}
export function archiveVersion(db:Database,id:string,versionId:string){
  const row=db.db.prepare('SELECT id,body_html,created_at FROM archive_versions WHERE archive_id=? AND id=?').get(id,versionId);
  if(!row)throw bad('归档版本不存在',404);
  const assets=db.db.prepare('SELECT id,kind,url,mime,bytes FROM archive_assets WHERE version_id=? ORDER BY kind,url').all(versionId);
  return {...row,assets};
}
export function archiveAsset(db:Database,archiveId:string,assetId:string){
  const item=db.db.prepare('SELECT kind,url,mime,bytes,data FROM archive_assets WHERE archive_id=? AND id=?').get(archiveId,assetId) as {kind:string;url:string;mime:string;bytes:number;data:Uint8Array}|undefined;
  if(!item)throw bad('归档资源不存在',404);
  return item;
}
