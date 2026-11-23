import {queryEntry,queryEntries,entryColumns,blocked,muted,ruleSaved,type EntryQueryOptions} from './entry-query';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statfsSync, statSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { aiPlainText } from './ai-text';
import { pairTokens } from './search-pairs';
import { bodyImages, mediaUrl, uniqueMedia, type EntryMedia } from './media';
import { declaredCanonical, entryIdentities } from './entry-identity';
import {sourceIconKey} from './source-icons';
import {installUnreadCounts,validateUnreadCounts,validateVisibilityIndexes,unreadCountTriggerNames} from './unread-counts';
import {installRawUnreadProjection,validateRawUnreadProjection,validateRawUnreadStructure,rawUnreadTriggerNames} from './raw-unread-projection';
import {installStableStorageKeys,validateStableStorageKeys} from './stable-storage';
import {installSearchRowidProjection,validateSearchRowidProjection,validateSearchRowidStructure} from './search-rowid-projection';
import {parseArticleAnchor,type ArticleAnchor} from '../shared/reading-anchor';

export const SCHEMA_VERSION = 44;
export function validateFetchInterval(value:unknown){if(value===undefined)return undefined;if(typeof value!=='number'||!Number.isInteger(value)||![0,15,30,60,180,360,720].includes(value))throw Object.assign(Error('刷新频率无效'),{statusCode:400});return value;}
export const RECOVERED_FEED_URL_PREFIX='https://recovered.invalid/feed/';
export const isRecoveredFeed=(feed:{url?:unknown})=>{if(typeof feed.url!=='string')return false;try{return new URL(feed.url).hostname.replace(/\.$/,'')==='recovered.invalid';}catch{return false;}};
export type MigrationStage='snapshot'|'schema'|'index'|'verify'|'done';
type MigrationPermit={path:string;version:number;db:DatabaseSync};
const migrationPermits=new WeakSet<MigrationPermit>();
const REQUIRED_COLUMNS:Record<string,string[]>={
  feeds:['id','title','url','site_url','description','icon','type','category_id','last_fetched_at','last_success_at','fetch_interval','enabled','failure_count','last_error','next_fetch_at','created_at','rsshub_instance_id','allow_private','json_mapping','folder_authorized'],
  feed_icon_keys:['feed_id','icon_key'],
  newsletter_files:['feed_id','file_name','modified_ms','size','failed'],
  categories:['id','name','icon','sort','created_at'],
  entries:['storage_id',...entryColumns],
  entry_media:['entry_id','kind','url','mime','source','title','created_at'],
  entry_identities:['feed_id','entry_id','kind','value'],
  ai_filter_decisions:['entry_id','decision','reason','criteria','provider','model','content_hash','updated_at'],
  permanent_archives:['id','source_entry_id','feed_id','feed_title','title','url','created_at','updated_at'],
  archive_versions:['id','archive_id','content_hash','body_html','created_at'],
  archive_assets:['id','archive_id','version_id','kind','url','mime','bytes','data'],
  ai_results:['id','entry_id','type','language','provider','model','content','prompt_version','content_hash','created_at'],
  ai_conversations:['id','title','entry_ids','created_at','updated_at'],
  ai_messages:['id','conversation_id','role','content','citations','provider','model','created_at'],
  ai_rules:['id','name','enabled','auto_run','conditions','action_type','max_items','provider','model','credential_id','last_error','created_at','updated_at'],
  ai_rule_jobs:['rule_id','entry_id','source_hash','provider','model','status','attempts','last_error','created_at','updated_at'],
  rsshub_instances:['id','name','base_url','enabled','created_at','allow_private'],
  tags:['id','name','color'],
  entry_tags:['entry_id','tag_id'],
  cached_images:['url','file_name','mime','bytes','saved_at','last_accessed_at'],
  reading_positions:['entry_id','progress','updated_at','anchor'],
  offline_saves:['entry_id','include_images','status','last_error','updated_at'],
  rules:['id','name','priority','enabled','conditions','action_type','tag_id','created_at','updated_at'],
  rule_matches:['rule_id','entry_id','created_at'],
  rivu_entry_visibility:['entry_id','feed_id','visible','sort_time','blocked','sort_bucket'],
  rivu_raw_unread_entries:['entry_id','feed_id','sort_time','sort_bucket'],
  rivu_feed_unread_counts:['feed_id','unread_count'],
  rivu_source_entry_counts:['feed_id','entry_count'],
  rivu_timeline_bucket_counts:['sort_bucket','entry_count','visible_count','blocked_count'],
  rivu_feed_timeline_bucket_counts:['sort_bucket','feed_id','category_id','entry_count','visible_count','blocked_count'],
  rivu_category_timeline_bucket_counts:['category_id','sort_bucket','entry_count','visible_count','blocked_count'],
  smart_folders:['id','name','query','sort','created_at','updated_at'],
  app_meta:['key','value'],
  entry_fts:['title','content','description','author'],
  ai_result_fts:['content'],
  entry_pair_fts:['pairs'],
  ai_result_pair_fts:['pairs'],
};

function archiveAssetKeys(db:DatabaseSync){
  return (db.prepare('PRAGMA index_list(archive_assets)').all() as {name:string;unique:number;partial:number}[]).filter(index=>index.unique&&!index.partial).map(index=>(db.prepare(`PRAGMA index_info('${index.name.replaceAll("'","''")}')`).all() as {name:string}[]).map(column=>column.name).join(','));
}
function installReadingAnchor(db:DatabaseSync){
  if(!(db.prepare('PRAGMA table_info(reading_positions)').all() as {name:string}[]).some(column=>column.name==='anchor'))
    db.exec('ALTER TABLE reading_positions ADD COLUMN anchor TEXT CHECK(anchor IS NULL OR (length(anchor)<=2048 AND json_valid(anchor)))');
}
export function validateSchema(db:DatabaseSync,checkForeignKeys=true){
  validateStableStorageKeys(db);validateSearchRowidStructure(db);
  for(const [table,required] of Object.entries(REQUIRED_COLUMNS)){
    const columns=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(column=>column.name));
    for(const name of required)if(!columns.has(name))throw Error(`数据库结构不完整：${table}.${name}`);
  }
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='feed_icon_keys_update'").get())throw Error('数据库结构不完整：feed_icon_keys_update');
  for(const name of ['entry_body_revision_insert','entry_body_revision_update'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error(`数据库结构不完整：${name}`);
  for(const name of ['entries_ai_identity','entries_list_metadata','entries_unread_cursor'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='entries'").get(name))throw Error(`数据库结构不完整：${name}`);
  for(const table of ['permanent_archives','archive_versions','archive_assets'])for(const event of ['insert','update','delete']){
    const name=`archive_revision_${table}_${event}`;
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error(`数据库结构不完整：${name}`);
  }
  const revision=db.prepare("SELECT value FROM app_meta WHERE key='archive_revision'").get() as {value:string}|undefined;
  if(!revision||!/^\d{1,19}$/.test(revision.value))throw Error('归档修订记录无效');
  const assetKeys=archiveAssetKeys(db);
  if(!assetKeys.includes('version_id,kind,url')||assetKeys.includes('version_id,url'))throw Error('归档资源身份索引无效');
  validateVisibilityIndexes(db);
  validateRawUnreadStructure(db);
  for(const name of unreadCountTriggerNames)if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))throw Error(`数据库结构不完整：${name}`);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='rivu_visibility_feed'").get())throw Error('数据库结构不完整：rivu_visibility_feed');
  if(checkForeignKeys){const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();if(foreignKeys.length)throw Error('数据库存在失效的关联记录');}
}

export type FeedInput = { title: string; url: string; siteUrl?: string; description?: string; icon?: string; categoryId?: string | null; fetchInterval?: number; type?: 'rss'|'rsshub'|'custom_json'|'newsletter'; rsshubInstanceId?:string|null; allowPrivate?:boolean; jsonMapping?:string; folderAuthorized?:boolean };
export type EntryInput = { guid?: string; title: string; author?: string; url?: string; canonicalUrl?:string; publishedAt?: string; content?: string; description?: string; cover?: string; media?:EntryMedia[] };
export type ReadScope={view?:'unread'|'today'|'all'|'starred'|'saved'|'summary'|'blocked'|'images'|'audio'|'video';feedId?:string;categoryId?:string;tagId?:string;ids?:string[]};
const invalidReadScope=(message:string)=>Object.assign(new Error(message),{statusCode:400});

export class RivuDatabase {
  db: DatabaseSync;
  private iconKeys=new Map<string,string|null>();
  private feedMetadataRows:Record<string,unknown>[]|null=null;
  private iconDataVersion=0;
  private initializeIconKeys(){
    for(const row of this.db.prepare('SELECT feed_id,icon_key FROM feed_icon_keys').all())if(row.icon_key===null||(typeof row.icon_key==='string'&&/^[a-f0-9]{64}$/.test(row.icon_key)))this.iconKeys.set(String(row.feed_id),row.icon_key);
    this.db.function('rivu_invalidate_icon',id=>{if(typeof id==='string')this.iconKeys.delete(id);this.feedMetadataRows=null;return null;});
    this.db.function('rivu_invalidate_feed_metadata',()=>{this.feedMetadataRows=null;return null;});
    // Connection-local triggers are neither migrated nor included in backups.
    this.db.exec(`CREATE TEMP TRIGGER rivu_icon_insert AFTER INSERT ON main.feeds BEGIN SELECT rivu_invalidate_icon(NEW.id); END;
      CREATE TEMP TRIGGER rivu_icon_update AFTER UPDATE OF icon,id ON main.feeds BEGIN SELECT rivu_invalidate_icon(OLD.id); SELECT rivu_invalidate_icon(NEW.id); END;
      CREATE TEMP TRIGGER rivu_icon_delete AFTER DELETE ON main.feeds BEGIN SELECT rivu_invalidate_icon(OLD.id); END;
      CREATE TEMP TRIGGER rivu_metadata_feed_update AFTER UPDATE ON main.feeds BEGIN SELECT rivu_invalidate_feed_metadata(); END;
      CREATE TEMP TRIGGER rivu_metadata_category_insert AFTER INSERT ON main.categories BEGIN SELECT rivu_invalidate_feed_metadata(); END;
      CREATE TEMP TRIGGER rivu_metadata_category_update AFTER UPDATE ON main.categories BEGIN SELECT rivu_invalidate_feed_metadata(); END;
      CREATE TEMP TRIGGER rivu_metadata_category_delete AFTER DELETE ON main.categories BEGIN SELECT rivu_invalidate_feed_metadata(); END;`);
    this.iconDataVersion=Number((this.db.prepare('PRAGMA data_version').get() as {data_version:number}).data_version);
  }
  private feedIconKey(id:string){
    if(!this.db.isTransaction&&this.iconKeys.has(id))return this.iconKeys.get(id)!;
    const cached=this.db.prepare('SELECT icon_key FROM feed_icon_keys WHERE feed_id=?').get(id) as {icon_key:unknown}|undefined;
    if(cached&&(cached.icon_key===null||(typeof cached.icon_key==='string'&&/^[a-f0-9]{64}$/.test(cached.icon_key)))){if(!this.db.isTransaction)this.iconKeys.set(id,cached.icon_key);return cached.icon_key;}
    const row=this.db.prepare('SELECT icon FROM feeds WHERE id=?').get(id) as {icon:unknown}|undefined;
    const key=sourceIconKey(row?.icon);
    if(row)this.db.prepare('INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?) ON CONFLICT(feed_id) DO UPDATE SET icon_key=excluded.icon_key').run(id,key);
    if(!this.db.isTransaction)this.iconKeys.set(id,key);
    return key;
  }
  invalidateFeedIconKey(id:string){this.iconKeys.delete(id);this.db.prepare('DELETE FROM feed_icon_keys WHERE feed_id=?').run(id);}
  static async open(path:string,onMigrationStage?:(stage:MigrationStage)=>void):Promise<RivuDatabase>{
    if(!existsSync(path)||statSync(path).size===0)return new RivuDatabase(path,onMigrationStage);
    const probe=new DatabaseSync(path,{readOnly:true});let version:number;
    try{version=Number(probe.prepare('PRAGMA user_version').get()!.user_version);}finally{probe.close();}
    if(version>SCHEMA_VERSION)throw Error(`数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}`);
    if(version===SCHEMA_VERSION)return new RivuDatabase(path,onMigrationStage,true);
    const walBytes=existsSync(path+'-wal')?BigInt(statSync(path+'-wal').size):0n;
    const required=(BigInt(statSync(path).size)+walBytes)*4n+1024n*1024n*1024n;
    const available=statfsSync(dirname(path),{bigint:true});
    if(available.bsize*available.bavail<required)throw Error(`数据库升级需要约 ${(Number(required)/1024**3).toFixed(1)} GiB 可用空间以保留迁移前快照和重建索引`);
    const snapshot=join(dirname(path),`pre-migration-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.db`);
    // Interrupted copies deliberately never use the published snapshot prefix.
    // Old partials are preserved as incomplete evidence, not recovery snapshots.
    const partial=join(dirname(path),`.rivu-migration-${randomUUID()}.partial`);
    const source=new DatabaseSync(path);let reader:DatabaseSync|undefined,delegated=false,snapshotReady=false;
    try{
      source.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
      if(Number(source.prepare('PRAGMA user_version').get()!.user_version)!==version)throw Error('数据库版本在升级准备期间已改变，请重新打开');
      try{onMigrationStage?.('snapshot');}catch{/* Observers cannot alter migration. */}
      // Reserve the writer while a separate readonly connection copies committed
      // pages. Unlike VACUUM INTO this retains article/AI rowids and FTS postings.
      reader=new DatabaseSync(path,{readOnly:true});await backup(reader,partial);reader.close();reader=undefined;
      const check=new DatabaseSync(partial);
      try{
        // Make the completed snapshot self-contained. Changing journal mode does
        // not rebuild tables or reassign rowids; readonly validation of a WAL
        // snapshot would otherwise leave sibling -wal/-shm files behind.
        check.exec('PRAGMA journal_mode=DELETE');
        if(Number(check.prepare('PRAGMA user_version').get()!.user_version)!==version||check.prepare('PRAGMA quick_check').get()!.quick_check!=='ok')throw Error('迁移前快照校验失败');
      }finally{check.close();}
      const handle=openSync(partial,'r+');try{fsyncSync(handle);}finally{closeSync(handle);}
      renameSync(partial,snapshot);
      snapshotReady=true;const permit={path:resolve(path),version,db:source};migrationPermits.add(permit);delegated=true;
      return new RivuDatabase(path,onMigrationStage,false,permit);
    }catch(error){if(!snapshotReady)for(const suffix of ['','-wal','-shm','-journal'])try{rmSync(partial+suffix,{force:true});}catch{/* Preserve original error. */}throw error;}
    finally{
      try{reader?.close();}finally{
        if(!delegated){try{if(source.isTransaction)source.exec('ROLLBACK');}finally{source.close();}}
      }
    }
  }
  constructor(readonly path: string,onMigrationStage?:(stage:MigrationStage)=>void,requireCurrent=false,permit?:MigrationPermit) {
    if(requireCurrent&&(!existsSync(path)||statSync(path).size===0))throw Error('后台写入需要已初始化的数据库');
    const reportStage=(stage:MigrationStage)=>{try{onMigrationStage?.(stage);}catch{/* Progress observers cannot alter migration results. */}};
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) && statSync(path).size > 0;
    if(permit&&(!migrationPermits.delete(permit)||permit.path!==resolve(path)||!permit.db.isTransaction))throw Error('无效的迁移快照许可');
    this.db = permit?.db??new DatabaseSync(path);
    try {
    this.db.function('rivu_pairs',{deterministic:true,varargs:true},pairTokens);
    const version = Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(requireCurrent&&version!==SCHEMA_VERSION)throw Error('后台写入不能创建或迁移数据库');
    if (version > SCHEMA_VERSION) throw Error(`数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}`);
    if(permit&&version!==permit.version)throw Error('数据库版本与迁移前快照不一致');
    if(existing&&version<SCHEMA_VERSION&&!permit)throw Error('已有数据库升级需要使用异步 RivuDatabase.open');
    if(!permit)this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    if (version === SCHEMA_VERSION) { validateSchema(this.db,false); this.initializeIconKeys(); return; }
    if(!permit)this.db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON');
    reportStage('schema');
    if(!this.db.isTransaction)this.db.exec('BEGIN IMMEDIATE');
    try {
    if(version===43){
      // Add only reading metadata; preserve all existing projections and their triggers.
      reportStage('index');installReadingAnchor(this.db);reportStage('verify');validateSchema(this.db);
      if(this.db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok')throw Error('数据库迁移后完整性校验失败');
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
      this.initializeIconKeys();reportStage('done');return;
    }
    for(const name of rawUnreadTriggerNames)this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    if(version>=35&&version<=42){
      // v41 adds only raw unread. v35-v40 also rebuild visibility first; retain
      // historical FTS/media/revision data and article bytes in either path.
      reportStage('index');if(version<41)installUnreadCounts(this.db);installRawUnreadProjection(this.db);
      installStableStorageKeys(this.db);installSearchRowidProjection(this.db);installReadingAnchor(this.db);reportStage('verify');
      validateSchema(this.db);validateUnreadCounts(this.db);validateRawUnreadProjection(this.db);
      validateSearchRowidProjection(this.db);
      const check=this.db.prepare('PRAGMA integrity_check').get() as {integrity_check:string};
      if(check.integrity_check!=='ok')throw Error('数据库迁移后完整性校验失败');
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
      this.initializeIconKeys();reportStage('done');return;
    }
    for(const name of unreadCountTriggerNames)this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, site_url TEXT, description TEXT, icon TEXT, type TEXT NOT NULL DEFAULT 'rss', category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, last_fetched_at TEXT, last_success_at TEXT, fetch_interval INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1, failure_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_fetch_at TEXT, created_at TEXT NOT NULL, allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1)), json_mapping TEXT, folder_authorized INTEGER NOT NULL DEFAULT 0 CHECK(folder_authorized IN (0,1)));
      CREATE TABLE IF NOT EXISTS feed_icon_keys (feed_id TEXT PRIMARY KEY NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,icon_key TEXT);
      CREATE TRIGGER IF NOT EXISTS feed_icon_keys_update AFTER UPDATE OF icon,id ON feeds BEGIN DELETE FROM feed_icon_keys WHERE feed_id IN (OLD.id,NEW.id); END;
      CREATE TABLE IF NOT EXISTS newsletter_files (feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, file_name TEXT NOT NULL, modified_ms INTEGER NOT NULL, size INTEGER NOT NULL, failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1)), PRIMARY KEY(feed_id,file_name));
      CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, guid TEXT, title TEXT NOT NULL, author TEXT, url TEXT, published_at TEXT, fetched_at TEXT NOT NULL, content TEXT, description TEXT, cover TEXT, language TEXT, read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, saved INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL, UNIQUE(feed_id, hash));
      CREATE TABLE IF NOT EXISTS entry_media (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video')), url TEXT NOT NULL, mime TEXT, source TEXT NOT NULL CHECK(source IN ('cover','body','enclosure','metadata')), title TEXT, created_at TEXT NOT NULL, PRIMARY KEY(entry_id,kind,url));
      CREATE UNIQUE INDEX IF NOT EXISTS entries_feed_id_identity ON entries(feed_id,id);
      CREATE TABLE IF NOT EXISTS entry_identities (feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, entry_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('hash','guid','url','canonical','content')), value TEXT NOT NULL, PRIMARY KEY(feed_id,kind,value,entry_id), FOREIGN KEY(feed_id,entry_id) REFERENCES entries(feed_id,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS entry_identities_entry ON entry_identities(entry_id);
      CREATE TABLE IF NOT EXISTS ai_filter_decisions (entry_id TEXT PRIMARY KEY NOT NULL REFERENCES entries(id) ON DELETE CASCADE, decision TEXT NOT NULL CHECK(decision IN ('mute','block')), reason TEXT NOT NULL, criteria TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permanent_archives (id TEXT PRIMARY KEY, source_entry_id TEXT NOT NULL UNIQUE, feed_id TEXT NOT NULL, feed_title TEXT NOT NULL, title TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_versions (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, content_hash TEXT NOT NULL, body_html TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS archive_versions_time ON archive_versions(archive_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS archive_assets (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,kind,url));
      CREATE INDEX IF NOT EXISTS archive_assets_archive ON archive_assets(archive_id,version_id);
      CREATE INDEX IF NOT EXISTS entry_media_kind ON entry_media(kind,entry_id);
      CREATE INDEX IF NOT EXISTS entries_feed_time ON entries(feed_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS entries_time ON entries(published_at DESC);
      CREATE INDEX IF NOT EXISTS entries_sort_time ON entries(COALESCE(published_at,fetched_at) DESC);
      CREATE INDEX IF NOT EXISTS entries_feed_sort_time ON entries(feed_id,COALESCE(published_at,fetched_at) DESC);
      CREATE INDEX IF NOT EXISTS entries_feed_unread ON entries(feed_id,read);
      CREATE INDEX IF NOT EXISTS entries_cursor_sort ON entries(COALESCE(published_at,fetched_at) DESC,id DESC);
      CREATE INDEX IF NOT EXISTS entries_feed_cursor_sort ON entries(feed_id,COALESCE(published_at,fetched_at) DESC,id DESC);
      CREATE TABLE IF NOT EXISTS ai_results (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, type TEXT NOT NULL, language TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL, content TEXT NOT NULL, prompt_version TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(entry_id, type, language, provider, model));
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_result_fts USING fts5(content, content='ai_results', content_rowid='rowid', tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS ai_result_pair_fts USING fts5(pairs, content='', contentless_delete=1, detail=none);
      CREATE TRIGGER IF NOT EXISTS ai_result_ai AFTER INSERT ON ai_results BEGIN INSERT INTO ai_result_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_ad AFTER DELETE ON ai_results BEGIN INSERT INTO ai_result_fts(ai_result_fts,rowid,content) VALUES ('delete',old.rowid,old.content); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_au AFTER UPDATE OF content ON ai_results BEGIN INSERT INTO ai_result_fts(ai_result_fts,rowid,content) VALUES ('delete',old.rowid,old.content); INSERT INTO ai_result_fts(rowid,content) VALUES (new.rowid,new.content); END;
      CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, entry_ids TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, citations TEXT NOT NULL DEFAULT '[]', provider TEXT, model TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages(conversation_id,created_at);
      CREATE TABLE IF NOT EXISTS ai_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), auto_run INTEGER NOT NULL DEFAULT 0 CHECK(auto_run IN (0,1)), conditions TEXT NOT NULL, action_type TEXT NOT NULL CHECK(action_type IN ('summary','keywords','classification')), max_items INTEGER NOT NULL DEFAULT 10 CHECK(max_items BETWEEN 1 AND 20), provider TEXT, model TEXT, credential_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_rule_jobs (rule_id TEXT NOT NULL REFERENCES ai_rules(id) ON DELETE CASCADE, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, source_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','paused')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(rule_id,entry_id));
      CREATE INDEX IF NOT EXISTS ai_rule_jobs_status ON ai_rule_jobs(status,updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(title, content, description, author, content='entries', content_rowid='rowid', tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_pair_fts USING fts5(pairs, content='', contentless_delete=1, detail=none);
      CREATE TRIGGER IF NOT EXISTS entry_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,new.content,new.description,new.author); END;
      CREATE TRIGGER IF NOT EXISTS entry_ad AFTER DELETE ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,old.content,old.description,old.author); END;
      CREATE TRIGGER IF NOT EXISTS entry_au AFTER UPDATE OF title,content,description,author ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,old.content,old.description,old.author); INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,new.content,new.description,new.author); END;
      CREATE TABLE IF NOT EXISTS rsshub_instances (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1)));
      CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#38A7F8');
      CREATE TABLE IF NOT EXISTS entry_tags (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(entry_id,tag_id));
      CREATE INDEX IF NOT EXISTS entry_tags_tag ON entry_tags(tag_id,entry_id);
      CREATE TABLE IF NOT EXISTS cached_images (url TEXT PRIMARY KEY, file_name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at TEXT NOT NULL, last_accessed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cached_images_access ON cached_images(last_accessed_at);
      CREATE TABLE IF NOT EXISTS reading_positions (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1), updated_at TEXT NOT NULL, anchor TEXT CHECK(anchor IS NULL OR (length(anchor)<=2048 AND json_valid(anchor))));
      CREATE TABLE IF NOT EXISTS offline_saves (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, include_images INTEGER NOT NULL CHECK(include_images IN (0,1)), status TEXT NOT NULL CHECK(status IN ('running','ready','partial','failed','interrupted')), last_error TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), conditions TEXT NOT NULL, action_type TEXT NOT NULL CHECK(action_type IN ('tag','save','mute','block')), tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_matches (rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE, entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(rule_id,entry_id));
      CREATE INDEX IF NOT EXISTS rule_matches_entry ON rule_matches(entry_id,rule_id);
      CREATE TABLE IF NOT EXISTS smart_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, query TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns=this.db.prepare('PRAGMA table_info(feeds)').all() as {name:string}[];
    if(!columns.some(x=>x.name==='rsshub_instance_id'))this.db.exec('ALTER TABLE feeds ADD COLUMN rsshub_instance_id TEXT REFERENCES rsshub_instances(id) ON DELETE SET NULL');
    if(!columns.some(x=>x.name==='allow_private'))this.db.exec('ALTER TABLE feeds ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1))');
    if(!columns.some(x=>x.name==='last_success_at')){this.db.exec('ALTER TABLE feeds ADD COLUMN last_success_at TEXT');if(['last_fetched_at','failure_count','last_error'].every(name=>columns.some(column=>column.name===name)))this.db.exec("UPDATE feeds SET last_success_at=last_fetched_at WHERE failure_count=0 AND last_error IS NULL");}
    if(!columns.some(x=>x.name==='json_mapping'))this.db.exec('ALTER TABLE feeds ADD COLUMN json_mapping TEXT');
    if(!columns.some(x=>x.name==='folder_authorized'))this.db.exec('ALTER TABLE feeds ADD COLUMN folder_authorized INTEGER NOT NULL DEFAULT 0 CHECK(folder_authorized IN (0,1))');
    const newsletterColumns=this.db.prepare('PRAGMA table_info(newsletter_files)').all() as {name:string}[];
    if(!newsletterColumns.some(x=>x.name==='failed'))this.db.exec('ALTER TABLE newsletter_files ADD COLUMN failed INTEGER NOT NULL DEFAULT 0 CHECK(failed IN (0,1))');
    // Some early databases retained articles after their feed row was removed.
    // Preserve those articles under a disabled, clearly identified local recovery source.
    const missingSources=this.db.prepare('SELECT DISTINCT e.feed_id id FROM entries e LEFT JOIN feeds f ON f.id=e.feed_id WHERE f.id IS NULL').all() as {id:string}[];
    const recovered=missingSources.length?this.db.prepare('INSERT INTO feeds(id,title,url,description,type,enabled,last_error,created_at) VALUES (?,?,?,?,?,?,?,?)'):null;
    for(const source of missingSources){
      const digest=createHash('sha256').update(source.id).digest('hex');
      recovered!.run(source.id,'恢复的原订阅（来源地址缺失）',`${RECOVERED_FEED_URL_PREFIX}${digest}`,'旧数据库中的文章已保留；原订阅地址无法从现有数据恢复。','rss',0,'来源地址缺失，请重新添加原订阅。',new Date().toISOString());
    }
    if(columns.some(column=>column.name==='enabled')&&columns.some(column=>column.name==='url')){
      const disable=this.db.prepare('UPDATE feeds SET enabled=0 WHERE id=?');
      for(const feed of this.db.prepare('SELECT id,url FROM feeds').all() as {id:string;url:string}[])if(isRecoveredFeed(feed))disable.run(feed.id);
    }
    const instanceColumns=this.db.prepare('PRAGMA table_info(rsshub_instances)').all() as {name:string}[];
    if(!instanceColumns.some(x=>x.name==='allow_private'))this.db.exec('ALTER TABLE rsshub_instances ADD COLUMN allow_private INTEGER NOT NULL DEFAULT 0 CHECK(allow_private IN (0,1))');
    const entryColumns=this.db.prepare('PRAGMA table_info(entries)').all() as {name:string}[];
    if(!entryColumns.some(x=>x.name==='full_content'))this.db.exec('ALTER TABLE entries ADD COLUMN full_content TEXT');
    if(!entryColumns.some(x=>x.name==='full_content_fetched_at'))this.db.exec('ALTER TABLE entries ADD COLUMN full_content_fetched_at TEXT');
    const aiColumns=this.db.prepare('PRAGMA table_info(ai_results)').all() as {name:string}[];
    if(!aiColumns.some(x=>x.name==='content_hash'))this.db.exec("ALTER TABLE ai_results ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
    if(version<19)reportStage('index');
    if(version<16)this.db.exec("INSERT INTO ai_result_fts(ai_result_fts) VALUES('rebuild')");
    if(version<18){
      this.db.exec('INSERT INTO entry_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(title,content,description,author,full_content) FROM entries');
      this.db.exec('INSERT INTO ai_result_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(content) FROM ai_results');
    }else if(version<19){
      this.db.exec('DELETE FROM entry_pair_fts; DELETE FROM ai_result_pair_fts');
      this.db.exec('INSERT INTO entry_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(title,content,description,author,full_content) FROM entries');
      this.db.exec('INSERT INTO ai_result_pair_fts(rowid,pairs) SELECT rowid,rivu_pairs(content) FROM ai_results');
    }
    const aiRuleColumns=this.db.prepare('PRAGMA table_info(ai_rules)').all() as {name:string}[];
    if(!aiRuleColumns.some(x=>x.name==='last_error'))this.db.exec('ALTER TABLE ai_rules ADD COLUMN last_error TEXT');
    if(!aiRuleColumns.some(x=>x.name==='credential_id'))this.db.exec('ALTER TABLE ai_rules ADD COLUMN credential_id TEXT');
    const archiveAssetColumns=this.db.prepare('PRAGMA table_info(archive_assets)').all() as {name:string}[];
    if(!archiveAssetColumns.some(x=>x.name==='version_id'))this.db.exec(`
      CREATE TABLE archive_assets_v15 (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,kind,url));
      INSERT INTO archive_assets_v15(id,archive_id,version_id,kind,url,mime,bytes,data) SELECT a.id,a.archive_id,(SELECT v.id FROM archive_versions v WHERE v.archive_id=a.archive_id ORDER BY v.created_at DESC,v.rowid DESC LIMIT 1),a.kind,a.url,a.mime,a.bytes,a.data FROM archive_assets a;
      DROP TABLE archive_assets;
      ALTER TABLE archive_assets_v15 RENAME TO archive_assets;
      CREATE INDEX archive_assets_archive ON archive_assets(archive_id,version_id);
    `);
    if(version<13){
      const old=this.db.prepare("SELECT e.id,e.url,e.cover,COALESCE(NULLIF(e.full_content,''),NULLIF(e.content,''),e.description,'') body,f.url feed_url FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE (e.cover IS NOT NULL AND e.cover<>'') OR e.full_content LIKE '%<img%' OR e.content LIKE '%<img%' OR e.description LIKE '%<img%'").all() as {id:string;url:string|null;cover:string|null;body:string;feed_url:string}[];
      const insert=this.db.prepare('INSERT OR IGNORE INTO entry_media(entry_id,kind,url,mime,source,title,created_at) VALUES (?,?,?,?,?,?,?)');
      for(const row of old){const base=row.url||row.feed_url,cover=mediaUrl(row.cover,base),items:EntryMedia[]=cover?[{kind:'image',url:cover,mime:null,source:'cover',title:null}]:[];items.push(...bodyImages(row.body,base));for(const media of uniqueMedia(items))insert.run(row.id,media.kind,media.url,media.mime,media.source,media.title,new Date().toISOString());}
    }
    this.db.exec(`
      DROP TRIGGER IF EXISTS entry_ai; DROP TRIGGER IF EXISTS entry_ad; DROP TRIGGER IF EXISTS entry_au;
      CREATE TRIGGER entry_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,COALESCE(new.full_content,new.content),new.description,new.author); END;
      CREATE TRIGGER entry_ad AFTER DELETE ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,COALESCE(old.full_content,old.content),old.description,old.author); END;
      CREATE TRIGGER entry_au AFTER UPDATE OF title,content,full_content,description,author ON entries BEGIN INSERT INTO entry_fts(entry_fts,rowid,title,content,description,author) VALUES ('delete',old.rowid,old.title,COALESCE(old.full_content,old.content),old.description,old.author); INSERT INTO entry_fts(rowid,title,content,description,author) VALUES (new.rowid,new.title,COALESCE(new.full_content,new.content),new.description,new.author); END;
      CREATE TRIGGER IF NOT EXISTS entry_pair_ai AFTER INSERT ON entries BEGIN INSERT INTO entry_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.title,new.content,new.description,new.author,new.full_content)); END;
      CREATE TRIGGER IF NOT EXISTS entry_pair_ad AFTER DELETE ON entries BEGIN DELETE FROM entry_pair_fts WHERE rowid=old.rowid; END;
      CREATE TRIGGER IF NOT EXISTS entry_pair_au AFTER UPDATE OF title,content,description,author,full_content ON entries BEGIN DELETE FROM entry_pair_fts WHERE rowid=old.rowid; INSERT INTO entry_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.title,new.content,new.description,new.author,new.full_content)); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_pair_ai AFTER INSERT ON ai_results BEGIN INSERT INTO ai_result_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.content)); END;
      CREATE TRIGGER IF NOT EXISTS ai_result_pair_ad AFTER DELETE ON ai_results BEGIN DELETE FROM ai_result_pair_fts WHERE rowid=old.rowid; END;
      CREATE TRIGGER IF NOT EXISTS ai_result_pair_au AFTER UPDATE OF content ON ai_results BEGIN DELETE FROM ai_result_pair_fts WHERE rowid=old.rowid; INSERT INTO ai_result_pair_fts(rowid,pairs) VALUES (new.rowid,rivu_pairs(new.content)); END;
    `);
    const seeded=this.db.prepare("SELECT value FROM app_meta WHERE key='rsshub_seeded'").get();
    if(version<27){
      const insertIdentity=this.db.prepare('INSERT OR IGNORE INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)');
      const rows=this.db.prepare('SELECT e.id,e.feed_id,e.guid,e.title,e.author,e.url,e.content,e.description,e.hash,f.url feed_url FROM entries e JOIN feeds f ON f.id=e.feed_id').iterate();
      for(const row of rows){const input=row as unknown as EntryInput&{id:string;feed_id:string;hash:string;feed_url:string};for(const identity of entryIdentities(input,input.feed_url))insertIdentity.run(input.feed_id,input.id,identity.kind,identity.value);}
    }
    if(!seeded){const count=Number((this.db.prepare('SELECT count(*) n FROM rsshub_instances').get() as {n:number}).n);if(count===0)this.db.prepare('INSERT INTO rsshub_instances(id,name,base_url,created_at) VALUES (?,?,?,?)').run(randomUUID(),'RSSHub 官方','https://rsshub.app',new Date().toISOString());this.db.prepare("INSERT INTO app_meta(key,value) VALUES ('rsshub_seeded','1')").run();}
    if(!archiveAssetKeys(this.db).includes('version_id,kind,url')||archiveAssetKeys(this.db).includes('version_id,url')){
      this.db.exec(`CREATE TABLE archive_assets_v32 (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES permanent_archives(id) ON DELETE CASCADE, version_id TEXT NOT NULL REFERENCES archive_versions(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('image','audio','video','snapshot')), url TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, UNIQUE(version_id,kind,url));
        INSERT INTO archive_assets_v32 SELECT id,archive_id,version_id,kind,url,mime,bytes,data FROM archive_assets;
        DROP TABLE archive_assets;
        ALTER TABLE archive_assets_v32 RENAME TO archive_assets;
        CREATE INDEX archive_assets_archive ON archive_assets(archive_id,version_id);`);
    }
    this.db.prepare("INSERT OR IGNORE INTO app_meta(key,value) VALUES ('archive_revision','0')").run();
    for(const table of ['permanent_archives','archive_versions','archive_assets'])for(const event of ['insert','update','delete']){
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS archive_revision_${table}_${event} AFTER ${event.toUpperCase()} ON ${table} BEGIN UPDATE app_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='archive_revision'; END;`);
    }
    if(!(this.db.prepare('PRAGMA table_info(entries)').all() as {name:string}[]).some(column=>column.name==='body_revision'))this.db.exec("ALTER TABLE entries ADD COLUMN body_revision TEXT NOT NULL DEFAULT '00000000000000000000000000000000' CHECK(length(body_revision)=32 AND body_revision NOT GLOB '*[^0-9a-f]*')");
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS entry_body_revision_insert AFTER INSERT ON entries BEGIN UPDATE entries SET body_revision=lower(hex(randomblob(16))) WHERE rowid=new.rowid; END;
      CREATE TRIGGER IF NOT EXISTS entry_body_revision_update AFTER UPDATE OF title,content,description,full_content ON entries WHEN old.title IS NOT new.title OR old.content IS NOT new.content OR old.description IS NOT new.description OR old.full_content IS NOT new.full_content BEGIN UPDATE entries SET body_revision=lower(hex(randomblob(16))) WHERE rowid=new.rowid; END;`);
    // Cover revision checks and list excerpts without traversing body overflow pages.
    this.db.exec(`CREATE INDEX IF NOT EXISTS entries_unread_cursor ON entries(read,COALESCE(published_at,fetched_at) DESC,id DESC,feed_id) WHERE read=0;
      CREATE INDEX IF NOT EXISTS entries_ai_identity ON entries(id,title,body_revision);
      CREATE INDEX IF NOT EXISTS entries_list_metadata ON entries(id,feed_id,title,author,url,published_at,fetched_at,substr(content,1,512),substr(description,1,512),cover,read,starred,saved,COALESCE(published_at,fetched_at),guid,language,archived,hash,full_content_fetched_at,body_revision);`);
    installReadingAnchor(this.db);
    installUnreadCounts(this.db);
    installRawUnreadProjection(this.db);
    installStableStorageKeys(this.db);installSearchRowidProjection(this.db);
    reportStage('verify');
    validateSchema(this.db);
    validateUnreadCounts(this.db);
    validateRawUnreadProjection(this.db);
    validateSearchRowidProjection(this.db);
    // Cover all non-image fields so reading columns after icon does not traverse its overflow pages.
    const metadataColumns=REQUIRED_COLUMNS.feeds.filter(column=>column!=='icon'&&column!=='title');
    this.db.exec(`CREATE INDEX IF NOT EXISTS feeds_metadata ON feeds(title COLLATE NOCASE,${metadataColumns.join(',')})`);
    if(version<29){const insert=this.db.prepare('INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?) ON CONFLICT(feed_id) DO UPDATE SET icon_key=excluded.icon_key');for(const row of this.db.prepare('SELECT id,icon FROM feeds').iterate())insert.run(row.id,sourceIconKey(row.icon));}
    const check = this.db.prepare('PRAGMA integrity_check').get() as {integrity_check:string};
    if (check.integrity_check !== 'ok') throw Error('数据库迁移后完整性校验失败');
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.db.exec('COMMIT');
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA legacy_alter_table=OFF');
    this.initializeIconKeys();
    reportStage('done');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  feeds(metadataOnly=false) {
    if(metadataOnly){const version=Number((this.db.prepare('PRAGMA data_version').get() as {data_version:number}).data_version);if(version!==this.iconDataVersion){this.iconKeys.clear();this.feedMetadataRows=null;this.iconDataVersion=version;}}
    const columns=metadataOnly?REQUIRED_COLUMNS.feeds.filter(column=>column!=='icon').map(column=>`f.${column}`).join(','):'f.*';
    if(metadataOnly){
      let rows=!this.db.isTransaction?this.feedMetadataRows:null;
      if(!rows){rows=this.db.prepare(`SELECT ${columns},c.name category_name, CASE WHEN f.enabled=0 THEN 'paused' WHEN f.failure_count>=5 THEN 'error' WHEN f.failure_count>0 THEN 'retrying' ELSE 'healthy' END health FROM feeds f LEFT JOIN categories c ON c.id=f.category_id ORDER BY f.title COLLATE NOCASE`).all();if(!this.db.isTransaction)this.feedMetadataRows=rows;}
      const counts=new Map(this.db.prepare('SELECT feed_id,unread_count FROM rivu_feed_unread_counts').all().map(row=>[String(row.feed_id),Number(row.unread_count)]));
      return rows.map(row=>({...row,icon:null,iconKey:this.feedIconKey(String(row.id)),unread_count:counts.get(String(row.id))??0}));
    }
    const rows=this.db.prepare(`SELECT ${columns}, c.name category_name, COALESCE(u.unread_count,0) unread_count, CASE WHEN f.enabled=0 THEN 'paused' WHEN f.failure_count>=5 THEN 'error' WHEN f.failure_count>0 THEN 'retrying' ELSE 'healthy' END health FROM feeds f LEFT JOIN categories c ON c.id=f.category_id LEFT JOIN rivu_feed_unread_counts u ON u.feed_id=f.id ORDER BY f.title COLLATE NOCASE`).all();
    return rows;
  }
  feed(id: string) { return this.db.prepare('SELECT * FROM feeds WHERE id=?').get(id) as Record<string, unknown> | undefined; }
  addFeed(input: FeedInput) {
    const interval=validateFetchInterval(input.fetchInterval);
    if(isRecoveredFeed(input))throw Object.assign(Error('此地址保留给历史文章恢复，不能作为新订阅'),{statusCode:400});
    const id = randomUUID();
    this.db.exec('SAVEPOINT add_feed_with_icon_key');
    try{
    this.db.prepare('INSERT INTO feeds(id,title,url,site_url,description,icon,category_id,fetch_interval,created_at,type,rsshub_instance_id,allow_private,json_mapping,folder_authorized) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.title,input.url,input.siteUrl ?? null,input.description ?? null,input.icon ?? null,input.categoryId ?? null,interval ?? 30,new Date().toISOString(),input.type??'rss',input.rsshubInstanceId??null,Number(input.allowPrivate===true),input.jsonMapping??null,Number(input.type==='newsletter'&&input.folderAuthorized===true));
    this.db.prepare('INSERT INTO feed_icon_keys(feed_id,icon_key) VALUES (?,?)').run(id,sourceIconKey(input.icon));
    this.db.exec('RELEASE add_feed_with_icon_key');
    }catch(error){this.db.exec('ROLLBACK TO add_feed_with_icon_key; RELEASE add_feed_with_icon_key');throw error;}
    return this.feed(id);
  }
  updateFeed(id: string, patch: {title?:string; categoryId?:string|null; enabled?:boolean; fetchInterval?:number; allowPrivate?:boolean}) {
    validateFetchInterval(patch.fetchInterval);
    const current = this.feed(id); if (!current) return undefined;
    if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw Object.assign(Error('订阅状态无效'),{statusCode:400});
    if(patch.enabled===true&&isRecoveredFeed(current))throw Object.assign(Error('原订阅地址缺失，无法启用；请重新添加原订阅'),{statusCode:400});
    this.db.prepare('UPDATE feeds SET title=?,category_id=?,enabled=?,fetch_interval=?,allow_private=? WHERE id=?').run(patch.title ?? String(current.title), patch.categoryId === undefined ? (current.category_id as string|null) : patch.categoryId, patch.enabled === undefined ? Number(current.enabled) : Number(patch.enabled), patch.fetchInterval ?? Number(current.fetch_interval),patch.allowPrivate===undefined?Number(current.allow_private):Number(patch.allowPrivate),id);
    return this.feed(id);
  }
  updateJsonMapping(id:string,mapping:string){
    const feed=this.feed(id);
    if(!feed||feed.type!=='custom_json')return undefined;
    this.db.prepare('UPDATE feeds SET json_mapping=? WHERE id=?').run(mapping,id);
    return this.feed(id);
  }
  reconnectNewsletter(id:string,url:string){
    const current=this.feed(id);if(!current||current.type!=='newsletter')return undefined;
    this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('UPDATE feeds SET url=?,folder_authorized=1,last_error=NULL,failure_count=0,next_fetch_at=NULL WHERE id=?').run(url,id);if(url!==current.url){this.db.prepare('DELETE FROM newsletter_files WHERE feed_id=?').run(id);this.db.prepare('DELETE FROM app_meta WHERE key=?').run(`newsletter_audit:${id}`);}this.db.exec('COMMIT');return this.feed(id);}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  deleteFeed(id: string) { this.db.exec('BEGIN');try{this.db.prepare('DELETE FROM ai_results WHERE entry_id IN (SELECT id FROM entries WHERE feed_id=?)').run(id);this.db.prepare('DELETE FROM entry_tags WHERE entry_id IN (SELECT id FROM entries WHERE feed_id=?)').run(id);this.db.prepare('DELETE FROM entries WHERE feed_id=?').run(id);const changes=this.db.prepare('DELETE FROM feeds WHERE id=?').run(id).changes;this.db.prepare('DELETE FROM app_meta WHERE key=?').run(`newsletter_audit:${id}`);this.db.prepare('DELETE FROM app_meta WHERE key=?').run('feed-metadata-write');this.db.exec('COMMIT');return changes;}catch(error){this.db.exec('ROLLBACK');throw error;} }
  categories() { return this.db.prepare('SELECT * FROM categories ORDER BY sort,name').all(); }
  addCategory(name: string) { const id=randomUUID(); this.db.prepare('INSERT INTO categories(id,name,created_at) VALUES (?,?,?)').run(id,name.trim(),new Date().toISOString()); return this.db.prepare('SELECT * FROM categories WHERE id=?').get(id); }
  deleteCategory(id: string) { this.db.exec('BEGIN');try{this.db.prepare('UPDATE feeds SET category_id=NULL WHERE category_id=?').run(id);const changes=this.db.prepare('DELETE FROM categories WHERE id=?').run(id).changes;this.db.exec('COMMIT');return changes;}catch(error){this.db.exec('ROLLBACK');throw error;} }
  addEntries(feedId:string, entries: (EntryInput & {hash:string})[],inTransaction=false) {
    if(inTransaction&&!this.db.isTransaction)throw Error('文章写入需要已有事务');
    const insert=this.db.prepare('INSERT INTO entries(id,feed_id,guid,title,author,url,published_at,fetched_at,content,description,cover,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertMedia=this.db.prepare('INSERT OR IGNORE INTO entry_media(entry_id,kind,url,mime,source,title,created_at) VALUES (?,?,?,?,?,?,?)');
    const insertIdentity=this.db.prepare('INSERT OR IGNORE INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)');
    const lookup=this.db.prepare('SELECT entry_id FROM entry_identities WHERE feed_id=? AND kind=? AND value=? LIMIT 2');
    const contentLookup=this.db.prepare("SELECT e.id FROM entry_identities i JOIN entries e ON e.id=i.entry_id WHERE i.feed_id=? AND i.kind=? AND i.value=? AND (?='' OR e.published_at IS NULL OR e.published_at='' OR e.published_at=? OR julianday(e.published_at)=julianday(?)) LIMIT 2");
    const existing=this.db.prepare('SELECT id FROM entries WHERE feed_id=? AND hash=?');
    const feed=this.feed(feedId);if(!feed)throw Error('订阅不存在');
    const conflict=()=>Object.assign(Error('文章标识存在冲突，本批次已保留原数据；请检查来源的 GUID 或文章地址'),{statusCode:409});
    if(!inTransaction)this.db.exec('BEGIN');try{
      let added=0;
      for(const e of entries){
        const identities=entryIdentities(e,String(feed.url)),matches=new Set<string>();let ambiguous=false;
        const exact=existing.get(feedId,e.hash) as {id:string}|undefined;if(exact)matches.add(exact.id);
        for(const identity of identities.filter(value=>value.kind!=='content')){
          const rows=lookup.all(feedId,identity.kind,identity.value) as {entry_id:string}[];
          if(rows.length>1)ambiguous=true;else if(rows.length===1)matches.add(rows[0].entry_id);
        }
        if(matches.size>1||!matches.size&&ambiguous)throw conflict();
        // Body equality is a fallback for sources without article URLs. Distinct
        // URLs remain distinct even when their boilerplate or text is identical.
        if(!matches.size&&feed.type!=='newsletter'&&!identities.some(value=>value.kind==='url'||value.kind==='canonical')){
          const content=identities.find(value=>value.kind==='content');
          if(content){
            const published=e.publishedAt||'',parsed=Date.parse(published),iso=Number.isFinite(parsed)?new Date(parsed).toISOString():published;
            const rows=contentLookup.all(feedId,'content',content.value,published,published,iso) as {id:string}[];
            for(const row of rows)matches.add(row.id);
            if(matches.size>1)throw conflict();
          }
        }
        const created=!matches.size,id=matches.values().next().value||randomUUID(),now=new Date().toISOString();
        if(created){insert.run(id,feedId,e.guid??null,e.title,e.author??null,e.url??null,e.publishedAt??null,now,e.content??null,e.description??null,e.cover??null,e.hash);added++;}
        for(const identity of identities)insertIdentity.run(feedId,id,identity.kind,identity.value);
        if(e.media===undefined)continue;
        if(!created)this.db.prepare("DELETE FROM entry_media WHERE entry_id=? AND source IN ('cover','enclosure','metadata')").run(id);
        for(const media of e.media.slice(0,60)){if(!created&&media.source==='body')continue;insertMedia.run(id,media.kind,media.url,media.mime,media.source,media.title,now);}
      }
      if(!inTransaction)this.db.exec('COMMIT');return added;
    }catch(error){if(!inTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  entryMedia(id:string){return this.db.prepare('SELECT kind,url,mime,source,title FROM entry_media WHERE entry_id=? ORDER BY CASE source WHEN \'cover\' THEN 0 WHEN \'body\' THEN 1 WHEN \'enclosure\' THEN 2 ELSE 3 END,url').all(id) as EntryMedia[];}
  entryImageIdentity(id:string,url:string){
    return this.db.prepare(`SELECT e.feed_id,e.url,e.hash,e.cover,e.body_revision,f.url feed_url,f.allow_private feed_allow_private,
      EXISTS(SELECT 1 FROM entry_media WHERE entry_id=e.id AND kind='image' AND url=?) has_image
      FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=?`).get(url,id) as {
      feed_id:string;url:string|null;hash:string;cover:string|null;body_revision:string;feed_url:string;feed_allow_private:number;has_image:number;
    }|undefined;
  }
  markFetch(id:string, error?:string) { const feed=this.db.prepare('SELECT failure_count,fetch_interval FROM feeds WHERE id=?').get(id); if(!feed)return; const now=Date.now(),attemptAt=new Date(now).toISOString(),failed=error!==undefined,failures=failed ? Number(feed.failure_count)+1 : 0; const minutes=failed ? Math.min(24*60,Math.max(Number(feed.fetch_interval),1)*2**Math.min(failures,6)) : Number(feed.fetch_interval); this.db.prepare('UPDATE feeds SET last_fetched_at=?,last_success_at=CASE WHEN ? THEN last_success_at ELSE ? END,failure_count=?,last_error=?,next_fetch_at=? WHERE id=?').run(attemptAt,Number(failed),attemptAt,failures,failed?error||'未知错误':null,new Date(now+minutes*60000).toISOString(),id); }
  refreshableFeeds(dueOnly=false) { return (this.db.prepare(`SELECT id,url FROM feeds WHERE enabled=1${dueOnly?' AND fetch_interval>0 AND (next_fetch_at IS NULL OR next_fetch_at<=?)':''}`).all(...(dueOnly?[new Date().toISOString()]:[])) as {id:string;url:string}[]).filter(feed=>!isRecoveredFeed(feed)); }
  dueFeeds() { return this.refreshableFeeds(true); }
  entries(opts:EntryQueryOptions={}) {return queryEntries(this.db,opts);}
  entry(id:string){return queryEntry(this.db,id);}
  aiBodySnapshot(id:string){return this.db.prepare("SELECT id,title,COALESCE(NULLIF(full_content,''),NULLIF(content,''),description,'') html,body_revision FROM entries WHERE id=?").get(id) as {id:string;title:string;html:string;body_revision:string}|undefined;}
  aiBodyIdentity(id:string){return this.db.prepare('SELECT id,title,body_revision FROM entries INDEXED BY entries_ai_identity WHERE id=?').get(id) as {id:string;title:string;body_revision:string}|undefined;}
  markRead(scope:ReadScope,inTransaction=false):string[]{
    if(inTransaction&&!this.db.isTransaction)throw Error('批量已读需要已有事务');
    const active=Object.entries(scope).filter(([,value])=>value!==undefined);
    if(active.length!==1)throw invalidReadScope('批量操作必须且只能指定一个范围');
    const [kind,value]=active[0];
    if(kind==='ids'){
      if(!Array.isArray(value)||value.length===0||value.length>5000||value.some(id=>typeof id!=='string'||!id))throw invalidReadScope('文章选择范围无效');
      const changed:string[]=[];if(!inTransaction)this.db.exec('BEGIN');
      try{for(let offset=0;offset<value.length;offset+=400){const chunk=[...new Set(value.slice(offset,offset+400))];const placeholders=chunk.map(()=>'?').join(',');const rows=this.db.prepare(`UPDATE entries SET read=1 WHERE read=0 AND id IN (${placeholders}) RETURNING id`).all(...chunk) as {id:string}[];changed.push(...rows.map(row=>row.id));}if(!inTransaction)this.db.exec('COMMIT');return changed;}
      catch(error){if(!inTransaction)this.db.exec('ROLLBACK');throw error;}
    }
    let where='e.read=0';const args:string[]=[];
    if(kind==='view'){
      if(!['unread','today','all','starred','saved','summary','blocked','images','audio','video'].includes(String(value)))throw invalidReadScope('无效的视图范围');
      where+=value==='blocked'?` AND ${blocked}`:` AND NOT ${blocked}`;
      if(value==='unread')where+=` AND NOT ${muted}`;
      if(value==='today')where+=" AND substr(e.published_at,1,10)=date('now','localtime')";
      if(value==='starred')where+=' AND e.starred=1';
      if(value==='saved')where+=` AND (e.saved=1 OR ${ruleSaved})`;
      if(value==='summary')where+=" AND EXISTS (SELECT 1 FROM ai_results a WHERE a.entry_id=e.id AND a.type='summary')";
      if(value==='images'||value==='audio'||value==='video'){where+=' AND EXISTS (SELECT 1 FROM entry_media em WHERE em.entry_id=e.id AND em.kind=?)';args.push(value==='images'?'image':value);}
    }else if(kind==='feedId'||kind==='categoryId'||kind==='tagId'){
      if(typeof value!=='string'||!value)throw invalidReadScope('无效的范围 ID');
      where+=` AND NOT ${blocked}`;
      if(kind==='feedId')where+=' AND e.feed_id=?';
      if(kind==='categoryId')where+=' AND f.category_id=?';
      if(kind==='tagId'){where+=" AND (EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=e.id AND et.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND rr.tag_id=?))";args.push(value,value);}else args.push(value);
    }else throw invalidReadScope('无效的批量操作范围');
    const rows=this.db.prepare(`UPDATE entries SET read=1 WHERE id IN (SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}) RETURNING id`).all(...args) as {id:string}[];
    return rows.map(row=>row.id);
  }
  undoMarkRead(ids:string[],inTransaction=false):number{
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id))throw Error('撤销范围无效');
    if(inTransaction&&!this.db.isTransaction)throw Error('撤销已读需要已有事务');
    if(!inTransaction)this.db.exec('BEGIN');
    try{let changed=0;for(let offset=0;offset<ids.length;offset+=400){const chunk=ids.slice(offset,offset+400);const placeholders=chunk.map(()=>'?').join(',');changed+=Number(this.db.prepare(`UPDATE entries SET read=0 WHERE read=1 AND id IN (${placeholders})`).run(...chunk).changes);}if(!inTransaction)this.db.exec('COMMIT');return changed;}
    catch(error){if(!inTransaction)this.db.exec('ROLLBACK');throw error;}
  }
  updateEntry(id:string,patch:{read?:boolean;starred?:boolean;saved?:boolean;archived?:boolean}){const current=this.entryState(id);if(!current)return undefined;this.db.prepare('UPDATE entries SET read=?,starred=?,saved=?,archived=? WHERE id=?').run(...(['read','starred','saved','archived'] as const).map(k=>patch[k]===undefined?Number(current[k]):Number(patch[k])),id);return this.entry(id);}
  readingPosition(id:string){
    const row=this.db.prepare('SELECT progress,updated_at,anchor FROM reading_positions WHERE entry_id=?').get(id) as {progress:number;updated_at:string;anchor:string|null}|undefined;
    if(!row)return undefined;
    let anchor:ArticleAnchor|null=null;try{if(row.anchor)anchor=parseArticleAnchor(JSON.parse(row.anchor));}catch{/* Invalid metadata must not discard the saved ratio. */}
    return {progress:row.progress,updated_at:row.updated_at,...(anchor?{anchor}:{})};
  }
  entryState(id:string){return this.db.prepare('SELECT e.id,e.feed_id,e.read,e.starred,e.saved,e.archived FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=? LIMIT 1').get(id) as {id:string;feed_id:string;read:number;starred:number;saved:number;archived:number}|undefined;}
  hasEntry(id:string){return !!this.db.prepare('SELECT 1 FROM entries e INDEXED BY entries_list_metadata JOIN feeds f ON f.id=e.feed_id WHERE e.id=? LIMIT 1').get(id);}
  saveReadingPosition(id:string,progress:number,value?:unknown){
    if(!Number.isFinite(progress)||progress<0||progress>1)throw invalidReadScope('阅读进度无效');
    const anchor=value==null?null:parseArticleAnchor(value);
    if(value!=null&&!anchor)throw invalidReadScope('阅读锚点无效');
    if(!this.hasEntry(id))return undefined;
    this.db.prepare('INSERT INTO reading_positions(entry_id,progress,updated_at,anchor) VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET progress=excluded.progress,updated_at=excluded.updated_at,anchor=excluded.anchor').run(id,progress,new Date().toISOString(),anchor?JSON.stringify(anchor):null);
    return this.readingPosition(id);
  }
  offlineSave(id:string){return this.db.prepare('SELECT include_images,status,last_error,updated_at FROM offline_saves WHERE entry_id=?').get(id) as {include_images:number;status:string;last_error:string|null;updated_at:string}|undefined;}
  setOfflineSave(id:string,includeImages:boolean,status:'running'|'ready'|'partial'|'failed'|'interrupted',error?:string){if(!this.hasEntry(id))return undefined;this.db.prepare('INSERT INTO offline_saves(entry_id,include_images,status,last_error,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET include_images=excluded.include_images,status=excluded.status,last_error=excluded.last_error,updated_at=excluded.updated_at').run(id,Number(includeImages),status,error??null,new Date().toISOString());return this.offlineSave(id);}
  interruptOfflineSaves(){this.db.prepare("UPDATE offline_saves SET status='interrupted',last_error='上次离线保存被中断',updated_at=? WHERE status='running'").run(new Date().toISOString());}
  aiResult(entryId:string,type:string,language:string){return this.db.prepare('SELECT id,entry_id,type,language,provider,model,content,prompt_version,created_at,content_hash FROM ai_results WHERE entry_id=? AND type=? AND language=? ORDER BY created_at DESC LIMIT 1').get(entryId,type,language);}
  validAIResult(entryId:string,type:string,language:string,provider:string,model:string,hash:string,promptVersion:string){return this.db.prepare('SELECT id,entry_id,type,language,provider,model,content,prompt_version,created_at,content_hash FROM ai_results WHERE entry_id=? AND type=? AND language=? AND provider=? AND model=? AND content_hash=? AND prompt_version=? LIMIT 1').get(entryId,type,language,provider,model,hash,promptVersion);}
  saveAI(entryId:string,type:string,language:string,provider:string,model:string,content:string,hash='',promptVersion='v1'){this.db.prepare('INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entry_id,type,language,provider,model) DO UPDATE SET content=excluded.content,prompt_version=excluded.prompt_version,content_hash=excluded.content_hash,created_at=excluded.created_at').run(randomUUID(),entryId,type,language,provider,model,content,promptVersion,hash,new Date().toISOString());return this.aiResult(entryId,type,language);}
  rsshubInstances(){return this.db.prepare('SELECT * FROM rsshub_instances ORDER BY created_at').all();}
  rsshubInstance(id:string){return this.db.prepare('SELECT * FROM rsshub_instances WHERE id=?').get(id) as {id:string;name:string;base_url:string;enabled:number;allow_private:number}|undefined;}
  addRsshubInstance(name:string,baseUrl:string,allowPrivate=false){const id=randomUUID();this.db.prepare('INSERT INTO rsshub_instances(id,name,base_url,allow_private,created_at) VALUES (?,?,?,?,?)').run(id,name,baseUrl,Number(allowPrivate),new Date().toISOString());return this.rsshubInstance(id);}
  deleteRsshubInstance(id:string){return this.db.prepare('DELETE FROM rsshub_instances WHERE id=?').run(id).changes;}
  tags(){return this.db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE').all();}
  filterDecision(entryId:string){return this.db.prepare('SELECT * FROM ai_filter_decisions WHERE entry_id=?').get(entryId) as {entry_id:string;decision:'mute'|'block';reason:string;criteria:string;provider:string;model:string;content_hash:string;updated_at:string}|undefined;}
  setFilterDecision(entryId:string,value:{decision:'keep'|'mute'|'block';reason:string;criteria:string;provider:string;model:string;content_hash:string}){
    if(!this.hasEntry(entryId))throw Object.assign(Error('文章不存在'),{statusCode:404});
    this.db.exec('BEGIN');
    try{
      if(value.decision==='keep')this.db.prepare('DELETE FROM ai_filter_decisions WHERE entry_id=?').run(entryId);
      else this.db.prepare('INSERT INTO ai_filter_decisions(entry_id,decision,reason,criteria,provider,model,content_hash,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,criteria=excluded.criteria,provider=excluded.provider,model=excluded.model,content_hash=excluded.content_hash,updated_at=excluded.updated_at').run(entryId,value.decision,value.reason,value.criteria,value.provider,value.model,value.content_hash,new Date().toISOString());
      this.db.exec('COMMIT');return this.filterDecision(entryId)||null;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  addTag(name:string,color='#38A7F8'){const id=randomUUID();this.db.prepare('INSERT INTO tags(id,name,color) VALUES (?,?,?)').run(id,name.trim(),color);return this.db.prepare('SELECT * FROM tags WHERE id=?').get(id);}
  appendEntryTagNames(entryId:string,names:string[],reconcile:(feedId:string)=>void){
    const entry=this.entryState(entryId);
    if(!entry)throw Object.assign(Error('文章不存在'),{statusCode:404});
    this.db.exec('BEGIN');
    try{
      const find=this.db.prepare('SELECT id FROM tags WHERE name=?');
      const add=this.db.prepare('INSERT OR IGNORE INTO entry_tags(entry_id,tag_id) VALUES (?,?)');
      for(const name of names){
        const existing=find.get(name) as {id:string}|undefined;
        const tag=existing||this.addTag(name) as {id:string};
        add.run(entryId,tag.id);
      }
      reconcile(entry.feed_id);
      const result=this.entryTags(entryId);
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  deleteTag(id:string){return this.db.prepare('DELETE FROM tags WHERE id=?').run(id).changes;}
  entryTags(entryId:string){return this.db.prepare("SELECT t.*,CASE WHEN EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=? AND et.tag_id=t.id) THEN 1 ELSE 0 END manual,CASE WHEN EXISTS (SELECT 1 FROM rule_matches rm JOIN rules r ON r.id=rm.rule_id WHERE rm.entry_id=? AND r.enabled=1 AND r.action_type='tag' AND r.tag_id=t.id) THEN 1 ELSE 0 END rule_based FROM tags t WHERE manual=1 OR rule_based=1 ORDER BY t.name").all(entryId,entryId);}
  setEntryTags(entryId:string,tagIds:string[]){if(!this.hasEntry(entryId))return undefined;this.db.exec('BEGIN');try{this.db.prepare('DELETE FROM entry_tags WHERE entry_id=?').run(entryId);const add=this.db.prepare('INSERT INTO entry_tags(entry_id,tag_id) VALUES (?,?)');for(const id of [...new Set(tagIds)])add.run(entryId,id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}return this.entryTags(entryId);}
  setFullContent(id:string,html:string,canonicalUrl?:string,inTransaction=false){if(inTransaction&&!this.db.isTransaction)throw Error('正文写入需要已开启事务');if(!inTransaction)this.db.exec('BEGIN');try{const current=this.db.prepare('SELECT e.full_content,e.content,e.description,e.url,f.url feed_url FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE e.id=?').get(id) as {full_content:string|null;content:string|null;description:string|null;url:string|null;feed_url:string}|undefined;const sameText=current&&aiPlainText(current.full_content||current.content||current.description||'').slice(0,40000)===aiPlainText(html||current.content||current.description||'').slice(0,40000);if(canonicalUrl&&current){const canonical=declaredCanonical(canonicalUrl,current.url||undefined,current.feed_url);if(canonical){const source=this.db.prepare('SELECT feed_id FROM entries WHERE id=?').get(id) as {feed_id:string};const conflict=this.db.prepare('SELECT entry_id FROM entry_identities WHERE feed_id=? AND kind=? AND value=? AND entry_id<>? LIMIT 1').get(source.feed_id,'canonical',canonical,id);if(!conflict)this.db.prepare('INSERT OR IGNORE INTO entry_identities(feed_id,entry_id,kind,value) VALUES (?,?,?,?)').run(source.feed_id,id,'canonical',canonical);}}if(current?.full_content===html){this.db.prepare('UPDATE entries SET full_content_fetched_at=? WHERE id=?').run(new Date().toISOString(),id);}else{this.db.prepare('UPDATE entries SET full_content=?,full_content_fetched_at=? WHERE id=?').run(html,new Date().toISOString(),id);this.db.prepare("DELETE FROM entry_media WHERE entry_id=? AND source='body'").run(id);const insert=this.db.prepare('INSERT OR IGNORE INTO entry_media(entry_id,kind,url,mime,source,title,created_at) VALUES (?,?,?,?,?,?,?)');for(const media of bodyImages(html,current?.url||current?.feed_url))insert.run(id,media.kind,media.url,media.mime,media.source,media.title,new Date().toISOString());if(!sameText)this.db.prepare("DELETE FROM ai_results WHERE entry_id=? AND type IN ('summary','translation','keywords','classification','explain','rewrite','custom','tags','filter')").run(id);}if(!inTransaction)this.db.exec('COMMIT');}catch(error){if(!inTransaction)this.db.exec('ROLLBACK');throw error;}return this.entry(id);}
  cachedImage(url:string){return this.db.prepare('SELECT * FROM cached_images WHERE url=?').get(url) as {url:string;file_name:string;mime:string;bytes:number}|undefined;}
  cachedImages(){return this.db.prepare('SELECT * FROM cached_images ORDER BY last_accessed_at ASC').all() as {url:string;file_name:string;mime:string;bytes:number}[];}
  saveCachedImage(url:string,fileName:string,mime:string,bytes:number){const now=new Date().toISOString();this.db.prepare('INSERT INTO cached_images(url,file_name,mime,bytes,saved_at,last_accessed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET file_name=excluded.file_name,mime=excluded.mime,bytes=excluded.bytes,last_accessed_at=excluded.last_accessed_at').run(url,fileName,mime,bytes,now,now);}
  touchCachedImage(url:string){this.db.prepare('UPDATE cached_images SET last_accessed_at=? WHERE url=?').run(new Date().toISOString(),url);}
  deleteCachedImage(url:string){this.db.prepare('DELETE FROM cached_images WHERE url=?').run(url);}
  backup(dest:string){return backup(this.db,dest);}
}
