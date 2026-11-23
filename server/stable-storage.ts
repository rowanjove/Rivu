import type {DatabaseSync} from 'node:sqlite';

const tables=['entries','ai_results'] as const;
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

// Next-schema primitive. The caller owns snapshot creation, migration transaction
// and restoring both PRAGMAs after COMMIT/ROLLBACK. Never rename the old table:
// child FK/trigger references must keep their original business table names.
export function installStableStorageKeys(db:DatabaseSync){
 if(!db.isTransaction||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==0||db.prepare('PRAGMA legacy_alter_table').get()?.legacy_alter_table!==1)throw Error('稳定存储迁移需要事务、关闭外键执行并启用兼容重命名');
 for(const table of tables){
  const columns=db.prepare(`PRAGMA table_info(${table})`).all();
  if(columns.some(row=>row.name==='storage_id')){validateStableStorageTable(db,table);continue;}
  if(columns.some(row=>['rowid','_rowid_','oid'].includes(String(row.name).toLowerCase())))throw Error('原表遮蔽物理行号，拒绝迁移');
  const primary=columns.filter(row=>Number(row.pk)>0);
  if(primary.length!==1||primary[0].name!=='id'||primary[0].type!=='TEXT')throw Error('原表业务身份约束不受支持：'+table);
  const staging=`rivu_stable_${table}`;
  if(db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(staging))throw Error('稳定存储迁移暂存名已存在：'+staging);
  const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string};
  const prefix=new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(?:"${table}"|${table})\\s*\\(`,'i');
  if(!prefix.test(original.sql)||!/\bid\s+TEXT\s+PRIMARY\s+KEY\b/i.test(original.sql))throw Error('原表定义不受支持：'+table);
  const sql=original.sql.replace(prefix,`CREATE TABLE ${staging} (storage_id INTEGER PRIMARY KEY NOT NULL,`).replace(/\bid\s+TEXT\s+PRIMARY\s+KEY\b/i,'id TEXT UNIQUE');
  const attached=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END,name").all(table) as {sql:string}[];
  db.exec(sql);
  const names=columns.map(row=>quote(String(row.name))).join(',');
  db.exec(`INSERT INTO ${staging}(storage_id,${names}) SELECT rowid,${names} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${staging} RENAME TO ${table};`);
  for(const item of attached)db.exec(item.sql);
  db.exec(`CREATE TRIGGER rivu_${table}_storage_immutable BEFORE UPDATE ON ${table} WHEN NEW.storage_id IS NOT OLD.storage_id BEGIN SELECT RAISE(ABORT,'稳定存储身份不可更改'); END`);
  validateStableStorageTable(db,table);
 }
}

function validateStableStorageTable(db:DatabaseSync,table:typeof tables[number]){
 const columns=db.prepare(`PRAGMA table_info(${table})`).all(),storage=columns.find(row=>row.name==='storage_id'),id=columns.find(row=>row.name==='id');
 if(!storage||storage.type!=='INTEGER'||storage.pk!==1||storage.notnull!==1||!id||id.type!=='TEXT'||id.pk!==0)throw Error('稳定存储主键无效：'+table);
 const indexes=db.prepare(`PRAGMA index_list(${table})`).all();
 if(indexes.some(row=>row.origin==='pk'))throw Error('稳定存储键必须是物理行号别名：'+table);
 const identity=indexes.some(index=>{
  if(index.unique!==1||index.partial!==0)return false;
  const keys=db.prepare('SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1 ORDER BY seqno').all(index.name);
  return keys.length===1&&keys[0].name==='id'&&keys[0].coll==='BINARY';
 });
 if(!identity)throw Error('稳定存储业务身份唯一约束无效：'+table);
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name=?").get(`rivu_${table}_storage_immutable`,table))throw Error('稳定存储身份保护缺失：'+table);
}

export function validateStableStorageKeys(db:DatabaseSync){for(const table of tables)validateStableStorageTable(db,table);}
