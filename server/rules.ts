import { randomUUID } from 'node:crypto';
import type { RivuDatabase } from './database';

export type RuleConditions={feedId?:string;titleKeyword?:string;bodyKeyword?:string;after?:string;before?:string;type?:'rss'|'rsshub'|'custom_json'|'newsletter';tagId?:string};
export type RuleAction={type:'tag'|'save'|'mute'|'block';tagId?:string};
export type RuleInput={name:string;priority?:number;enabled?:boolean;conditions:RuleConditions;action:RuleAction};
type StoredRule={id:string;name:string;priority:number;enabled:number;conditions:string;action_type:RuleAction['type'];tag_id:string|null;created_at:string;updated_at:string};
const bad=(message:string)=>Object.assign(Error(message),{statusCode:400});
const missing=(message:string)=>Object.assign(Error(message),{statusCode:404});

export function validateRule(db:RivuDatabase,input:unknown):RuleInput{
  if(!input||typeof input!=='object'||Array.isArray(input))throw bad('规则内容无效');
  const raw=input as Record<string,unknown>;
  if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.trim().length>80)throw bad('规则名称应为 1 至 80 字');
  if(raw.priority!==undefined&&(!Number.isInteger(raw.priority)||Number(raw.priority)<-1000||Number(raw.priority)>1000))throw bad('优先级应为 -1000 至 1000 的整数');
  if(raw.enabled!==undefined&&typeof raw.enabled!=='boolean')throw bad('启用状态无效');
  if(!raw.conditions||typeof raw.conditions!=='object'||Array.isArray(raw.conditions))throw bad('规则条件无效');
  const conditions=raw.conditions as Record<string,unknown>;
  const allowed=['feedId','titleKeyword','bodyKeyword','after','before','type','tagId'];
  if(Object.keys(conditions).some(key=>!allowed.includes(key)))throw bad('包含不支持的规则条件');
  for(const key of allowed)if(conditions[key]!==undefined&&(typeof conditions[key]!=='string'||!String(conditions[key]).trim()))throw bad(`${key} 条件无效`);
  for(const key of ['titleKeyword','bodyKeyword'])if(String(conditions[key]||'').length>200)throw bad('关键词最长 200 字');
  for(const key of ['after','before'])if(conditions[key]!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(String(conditions[key]))||Number.isNaN(Date.parse(String(conditions[key])))))throw bad('日期必须使用 YYYY-MM-DD');
  if(conditions.after&&conditions.before&&String(conditions.after)>String(conditions.before))throw bad('开始日期不能晚于结束日期');
  if(conditions.type!==undefined&&!['rss','rsshub','custom_json','newsletter'].includes(String(conditions.type)))throw bad('订阅类型无效');
  if(conditions.feedId&&!db.feed(String(conditions.feedId)))throw bad('订阅不存在');
  if(conditions.tagId&&!db.db.prepare('SELECT id FROM tags WHERE id=?').get(String(conditions.tagId)))throw bad('条件标签不存在');
  if(!raw.action||typeof raw.action!=='object'||Array.isArray(raw.action))throw bad('规则动作无效');
  const action=raw.action as Record<string,unknown>;
  if(!['tag','save','mute','block'].includes(String(action.type)))throw bad('规则动作无效');
  if(action.type==='tag'){
    if(typeof action.tagId!=='string'||!db.db.prepare('SELECT id FROM tags WHERE id=?').get(action.tagId))throw bad('动作标签不存在');
    if(action.tagId===conditions.tagId)throw bad('标签条件与动作不能使用同一标签');
  }else if(action.tagId!==undefined)throw bad('该动作不需要标签');
  return {name:raw.name.trim(),priority:raw.priority===undefined?0:Number(raw.priority),enabled:raw.enabled===undefined?true:raw.enabled as boolean,conditions:Object.fromEntries(Object.entries(conditions).map(([key,value])=>[key,String(value).trim()])) as RuleConditions,action:{type:action.type as RuleAction['type'],tagId:action.tagId as string|undefined}};
}

function publicRule(row:StoredRule){return {id:row.id,name:row.name,priority:row.priority,enabled:!!row.enabled,conditions:JSON.parse(row.conditions) as RuleConditions,action:{type:row.action_type,...(row.tag_id?{tagId:row.tag_id}:{})},createdAt:row.created_at,updatedAt:row.updated_at};}
export function listRules(db:RivuDatabase){return (db.db.prepare('SELECT * FROM rules ORDER BY priority DESC,created_at,id').all() as StoredRule[]).map(publicRule);}
function rule(db:RivuDatabase,id:string){const row=db.db.prepare('SELECT * FROM rules WHERE id=?').get(id) as StoredRule|undefined;if(!row)throw missing('规则不存在');return row;}
export function createRule(db:RivuDatabase,raw:unknown){const input=validateRule(db,raw);const now=new Date().toISOString(),id=randomUUID();db.db.prepare('INSERT INTO rules(id,name,priority,enabled,conditions,action_type,tag_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,input.name,input.priority??0,Number(input.enabled),JSON.stringify(input.conditions),input.action.type,input.action.tagId??null,now,now);return publicRule(rule(db,id));}
export function updateRule(db:RivuDatabase,id:string,raw:unknown){const old=rule(db,id);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw bad('规则修改无效');const patch=raw as Record<string,unknown>;if(Object.keys(patch).some(key=>!['name','priority','enabled'].includes(key)))throw bad('规则条件或动作请重新创建');const input=validateRule(db,{name:patch.name??old.name,priority:patch.priority??old.priority,enabled:patch.enabled??!!old.enabled,conditions:JSON.parse(old.conditions),action:{type:old.action_type,tagId:old.tag_id??undefined}});db.db.exec('BEGIN');try{db.db.prepare('UPDATE rules SET name=?,priority=?,enabled=?,updated_at=? WHERE id=?').run(input.name,input.priority??0,Number(input.enabled),new Date().toISOString(),id);applyEnabledRules(db,undefined,true);db.db.exec('COMMIT');return publicRule(rule(db,id));}catch(error){db.db.exec('ROLLBACK');throw error;}}
export function deleteRule(db:RivuDatabase,id:string){rule(db,id);db.db.exec('BEGIN');try{db.db.prepare('DELETE FROM rules WHERE id=?').run(id);applyEnabledRules(db,undefined,true);db.db.exec('COMMIT');return {deleted:true};}catch(error){db.db.exec('ROLLBACK');throw error;}}
export function undoRule(db:RivuDatabase,id:string){rule(db,id);db.db.exec('BEGIN');try{db.db.prepare('UPDATE rules SET enabled=0,updated_at=? WHERE id=?').run(new Date().toISOString(),id);const removed=Number(db.db.prepare('DELETE FROM rule_matches WHERE rule_id=?').run(id).changes);applyEnabledRules(db,undefined,true);db.db.exec('COMMIT');return {removed,enabled:false};}catch(error){db.db.exec('ROLLBACK');throw error;}}
export function deleteTagAndReconcile(db:RivuDatabase,id:string){db.db.exec('BEGIN');try{const dependent=(db.db.prepare('SELECT id,conditions FROM rules').all() as {id:string;conditions:string}[]).filter(row=>(JSON.parse(row.conditions) as RuleConditions).tagId===id);for(const row of dependent)db.db.prepare('DELETE FROM rules WHERE id=?').run(row.id);const deleted=Number(db.deleteTag(id));if(deleted)applyEnabledRules(db,undefined,true);db.db.exec('COMMIT');return {deleted,removedRules:dependent.length};}catch(error){db.db.exec('ROLLBACK');throw error;}}

function selection(row:StoredRule,feedId?:string){
  const conditions=JSON.parse(row.conditions) as RuleConditions;
  const where:string[]=[];const args:(string|number)[]=[];
  if(feedId){where.push('e.feed_id=?');args.push(feedId);}
  if(conditions.feedId){where.push('e.feed_id=?');args.push(conditions.feedId);}
  if(conditions.titleKeyword){where.push("instr(lower(e.title),lower(?))>0");args.push(conditions.titleKeyword);}
  if(conditions.bodyKeyword){where.push("instr(lower(COALESCE(NULLIF(e.full_content,''),NULLIF(e.content,''),e.description,'')),lower(?))>0");args.push(conditions.bodyKeyword);}
  if(conditions.after){where.push('substr(COALESCE(e.published_at,e.fetched_at),1,10)>=?');args.push(conditions.after);}
  if(conditions.before){where.push('substr(COALESCE(e.published_at,e.fetched_at),1,10)<=?');args.push(conditions.before);}
  if(conditions.type){where.push('f.type=?');args.push(conditions.type);}
  if(conditions.tagId){where.push("(EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=e.id AND et.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches m JOIN rules r ON r.id=m.rule_id WHERE m.entry_id=e.id AND r.enabled=1 AND r.action_type='tag' AND r.tag_id=? AND (r.priority>? OR (r.priority=? AND (r.created_at<? OR (r.created_at=? AND r.id<?))))))");args.push(conditions.tagId,conditions.tagId,row.priority,row.priority,row.created_at,row.created_at,row.id);}
  return {where:where.length?where.join(' AND '):'1=1',args};
}
function previewSelection(db:RivuDatabase,row:StoredRule,feedId?:string){const {where,args}=selection(row,feedId);const from=`FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}`;const matching=Number((db.db.prepare(`SELECT count(*) n ${from}`).get(...args) as {n:number}).n);const pending=Number((db.db.prepare(`SELECT count(*) n ${from} AND NOT EXISTS (SELECT 1 FROM rule_matches m WHERE m.rule_id=? AND m.entry_id=e.id)`).get(...args,row.id) as {n:number}).n);const sample=db.db.prepare(`SELECT e.id,e.title,f.title feedTitle ${from} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC LIMIT 20`).all(...args);return {matching,pending,sample};}
export function previewRule(db:RivuDatabase,id:string,feedId?:string){return previewSelection(db,rule(db,id),feedId);}
export function previewDraft(db:RivuDatabase,raw:unknown){const input=validateRule(db,raw);const row={id:'__draft__',priority:input.priority??0,created_at:new Date().toISOString(),conditions:JSON.stringify(input.conditions)} as StoredRule;return previewSelection(db,row);}
function reconcile(db:RivuDatabase,row:StoredRule,feedId?:string,inTransaction=false){const {where,args}=selection(row,feedId);const scope=feedId?' AND entry_id IN (SELECT id FROM entries WHERE feed_id=?)':'';const matchingSql=`SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}`;if(!inTransaction)db.db.exec('BEGIN');try{const removed=Number(db.db.prepare(`DELETE FROM rule_matches WHERE rule_id=?${scope} AND entry_id NOT IN (${matchingSql})`).run(row.id,...(feedId?[feedId]:[]),...args).changes);const inserted=Number(db.db.prepare(`INSERT OR IGNORE INTO rule_matches(rule_id,entry_id,created_at) SELECT ?,e.id,? FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}`).run(row.id,new Date().toISOString(),...args).changes);if(!inTransaction)db.db.exec('COMMIT');return {inserted,removed};}catch(error){if(!inTransaction)db.db.exec('ROLLBACK');throw error;}}
export function applyRule(db:RivuDatabase,id:string){const row=rule(db,id);if(!row.enabled)throw bad('规则已停用');return {...reconcile(db,row),preview:previewRule(db,id)};}
export function applyEnabledRules(db:RivuDatabase,feedId?:string,inTransaction=false){let inserted=0,removed=0;if(!inTransaction)db.db.exec('BEGIN');try{for(const row of db.db.prepare('SELECT * FROM rules WHERE enabled=1 ORDER BY priority DESC,created_at,id').all() as StoredRule[]){const result=reconcile(db,row,feedId,true);inserted+=result.inserted;removed+=result.removed;}if(!inTransaction)db.db.exec('COMMIT');return {inserted,removed};}catch(error){if(!inTransaction)db.db.exec('ROLLBACK');throw error;}}
