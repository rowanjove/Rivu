import { randomUUID } from 'node:crypto';
import type { RivuDatabase } from './database';

type Folder={id:string;name:string;query:string;sort:number;created_at:string;updated_at:string};
const bad=(message:string)=>Object.assign(Error(message),{statusCode:400});
const missing=()=>Object.assign(Error('智能分类不存在'),{statusCode:404});
const conflict=()=>Object.assign(Error('智能分类名称已存在'),{statusCode:409});
const tokens=(query:string)=>query.match(/(?:[^\s"]+|"[^"]*")+/g)??[];
function validDate(value:string){if(/^\d{1,4}d$/i.test(value))return Number.parseInt(value,10)>0&&Number.parseInt(value,10)<=3650;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(`${value}T00:00:00Z`);return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;}
export function validateSavedQuery(raw:unknown){
  if(typeof raw!=='string'||!raw.trim()||raw.trim().length>500)throw bad('保存的查询应为 1 至 500 字');
  const query=raw.trim().replace(/\s+/g,' '),parts=tokens(query);
  if(parts.length>25)throw bad('查询条件过多');
  for(const part of parts){
    if(part.toUpperCase()==='AND')continue;
    if(part.toUpperCase()==='OR')throw bad('智能分类仅支持 AND 条件');
    const term=part.match(/^([a-z]+):(.+)$/i);
    if(!term){if(/^[a-z]+:/i.test(part))throw bad(`不支持的搜索条件：${part}`);continue;}
    const kind=term[1].toLowerCase(),value=term[2];
    if(['feed','tag'].includes(kind)){if(value.length>100)throw bad('订阅或标签条件过长');continue;}
    if(kind==='is'){if(!['unread','starred','saved','muted','blocked'].includes(value.toLowerCase()))throw bad(`不支持的状态：${value}`);continue;}
    if(['after','before'].includes(kind)){if(!validDate(value))throw bad('日期须为 YYYY-MM-DD 或 7d 一类相对天数');continue;}
    throw bad(`不支持的搜索条件：${kind}`);
  }
  return parts.map(part=>/^(unread|starred|saved|muted|blocked)$/i.test(part)?`is:${part.toLowerCase()}`:part).join(' ');
}
function validName(raw:unknown){if(typeof raw!=='string'||!raw.trim()||raw.trim().length>80)throw bad('智能分类名称应为 1 至 80 字');return raw.trim();}
export function listSmartFolders(db:RivuDatabase){return db.db.prepare('SELECT * FROM smart_folders ORDER BY sort,name COLLATE NOCASE').all() as Folder[];}
export function getSmartFolder(db:RivuDatabase,id:string){const row=db.db.prepare('SELECT * FROM smart_folders WHERE id=?').get(id) as Folder|undefined;if(!row)throw missing();return row;}
function assertNameAvailable(db:RivuDatabase,name:string,exceptId?:string){const row=db.db.prepare('SELECT id FROM smart_folders WHERE name=? COLLATE NOCASE').get(name) as {id:string}|undefined;if(row&&row.id!==exceptId)throw conflict();}
export function createSmartFolder(db:RivuDatabase,raw:unknown){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw bad('智能分类内容无效');const input=raw as Record<string,unknown>,name=validName(input.name),query=validateSavedQuery(input.query);assertNameAvailable(db,name);const now=new Date().toISOString(),id=randomUUID();const sort=Number((db.db.prepare('SELECT COALESCE(MAX(sort),-1)+1 n FROM smart_folders').get() as {n:number}).n);db.db.prepare('INSERT INTO smart_folders(id,name,query,sort,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id,name,query,sort,now,now);return getSmartFolder(db,id);}
export function updateSmartFolder(db:RivuDatabase,id:string,raw:unknown){const current=getSmartFolder(db,id);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw bad('智能分类修改无效');const input=raw as Record<string,unknown>;if(Object.keys(input).some(key=>!['name','query','sort'].includes(key)))throw bad('智能分类修改字段无效');const name=input.name===undefined?current.name:validName(input.name),query=input.query===undefined?current.query:validateSavedQuery(input.query);const sort=input.sort===undefined?current.sort:input.sort;if(!Number.isInteger(sort)||Number(sort)<0||Number(sort)>10000)throw bad('排序值无效');assertNameAvailable(db,name,id);db.db.prepare('UPDATE smart_folders SET name=?,query=?,sort=?,updated_at=? WHERE id=?').run(name,query,Number(sort),new Date().toISOString(),id);return getSmartFolder(db,id);}
export function deleteSmartFolder(db:RivuDatabase,id:string){getSmartFolder(db,id);return {deleted:Number(db.db.prepare('DELETE FROM smart_folders WHERE id=?').run(id).changes)};}
export function previewSmartFolder(db:RivuDatabase,raw:unknown){const query=validateSavedQuery(raw);const rows=db.entries({query,limit:21,listOnly:true}) as {id:string;title:string;feed_title:string}[];return {sample:rows.slice(0,20),hasMore:rows.length>20};}
export function smartFolderEntries(db:RivuDatabase,id:string,limit:number,offset:number,cursor?:{sortTime:string;id:string}){const folder=getSmartFolder(db,id);if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0)throw bad('分页参数无效');return db.entries({query:folder.query,limit,offset,cursor,listOnly:true});}
export function markSmartFolderRead(db:RivuDatabase,id:string,inTransaction=false){if(inTransaction&&!db.db.isTransaction)throw Error('智能分类批量已读需要已有事务');const folder=getSmartFolder(db,id);const ids:string[]=[];let cursor:{sortTime:string;id:string}|undefined;for(;;){const page=db.entries({query:folder.query,limit:500,cursor,listOnly:true}) as {id:string;read:number;published_at:string|null;fetched_at:string}[];ids.push(...page.filter(row=>!row.read).map(row=>row.id));if(page.length<500)break;const last=page[page.length-1];cursor={sortTime:last.published_at||last.fetched_at,id:last.id};}const changed:string[]=[];if(!inTransaction)db.db.exec('BEGIN');try{for(let offset=0;offset<ids.length;offset+=400){const chunk=ids.slice(offset,offset+400),marks=chunk.map(()=>'?').join(',');changed.push(...(db.db.prepare(`UPDATE entries SET read=1 WHERE read=0 AND id IN (${marks}) RETURNING id`).all(...chunk) as {id:string}[]).map(row=>row.id));}if(!inTransaction)db.db.exec('COMMIT');return changed;}catch(error){if(!inTransaction)db.db.exec('ROLLBACK');throw error;}}
