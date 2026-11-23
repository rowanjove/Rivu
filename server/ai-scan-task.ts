import {DatabaseSync} from 'node:sqlite';
import type {RuleConditions} from './rules';
import {selection} from './ai-rule-selection';
export type AICursor={date:string;id:string};
export type AIScanInput={databasePath:string;conditions:RuleConditions;limit:number;count?:boolean;feedId?:string;since?:string;cursor?:AICursor;entryId?:string};
export type AIScanRow={id:string;title:string;feed_title:string;date:string;body_revision:string};
export type AIScanResult={matching?:number;rows:AIScanRow[]};
export type AIBodyInput={operation:'bodies';databasePath:string;entryIds:string[];maxBytes:number};
export type AIBodyRow={id:string;title:string;html:string;body_revision:string};
export type AIBodyResult={rows:AIBodyRow[];bytes:number};
export const AI_BODY_SIZE_SQL='SELECT octet_length(title) title_bytes,octet_length(full_content) full_bytes,octet_length(content) content_bytes,octet_length(description) description_bytes FROM entries WHERE id=?';
export function readAIBodies(input:AIBodyInput,onSnapshot?:()=>void):AIBodyResult{
  if(!Array.isArray(input.entryIds)||!input.entryIds.length||input.entryIds.length>20||input.entryIds.some(id=>typeof id!=='string'||!id)||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<0||input.maxBytes>64*1024*1024)throw Object.assign(Error('AI 正文读取参数无效'),{statusCode:400});
  const busy=()=>Object.assign(Error('AI 正文准备繁忙，请稍后重试'),{statusCode:503,resourceBusy:true});
  const db=new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
  try{
    db.exec('PRAGMA query_only=ON; BEGIN');db.prepare('SELECT 1 FROM entries LIMIT 1').get();onSnapshot?.();
    const source="COALESCE(NULLIF(full_content,''),NULLIF(content,''),description,'')";
    const size=db.prepare(AI_BODY_SIZE_SQL),body=db.prepare(`SELECT id,title,${source} html,body_revision FROM entries WHERE id=?`);
    const rows:AIBodyRow[]=[];let bytes=0;
    for(const id of new Set(input.entryIds)){
      const metadata=size.get(id) as {title_bytes:number;full_bytes:number|null;content_bytes:number|null;description_bytes:number|null}|undefined;if(!metadata)throw Object.assign(Error('文章不存在'),{statusCode:404});
      // Valid UTF-8 uses at most 3 bytes per UTF-16 code unit. Bound the
      // transient read before materializing strings, then charge exact JS units.
      const encodedBytes=metadata.title_bytes+(metadata.full_bytes||metadata.content_bytes||metadata.description_bytes||0);
      if(encodedBytes>Math.max(0,input.maxBytes-bytes-256)*1.5)throw busy();
      const row=body.get(id) as AIBodyRow,cost=256+2*(row.html.length+row.title.length);if(bytes+cost>input.maxBytes)throw busy();
      rows.push(row);bytes+=cost;
    }
    return {rows,bytes};
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
export function scanAIRule(input:AIScanInput,onSnapshot?:()=>void):AIScanResult{
  if(!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw Object.assign(Error('AI 规则扫描参数无效'),{statusCode:400});
  const db=new DatabaseSync(input.databasePath,{readOnly:true,timeout:10000});
  try{db.exec('PRAGMA query_only=ON; BEGIN');db.prepare('SELECT 1 FROM entries LIMIT 1').get();onSnapshot?.();
    const {where,args}=selection(input.conditions,input.feedId,input.since);
    if(input.entryId!==undefined)args.push(input.entryId);
    const from=`FROM entries e JOIN feeds f ON f.id=e.feed_id WHERE ${where}${input.entryId!==undefined?' AND e.id=?':''}`;
    const matching=input.count?Number((db.prepare(`SELECT count(*) n ${from}`).get(...args) as {n:number}).n):undefined;
    const cursor=input.cursor?' AND (COALESCE(e.published_at,e.fetched_at)<? OR (COALESCE(e.published_at,e.fetched_at)=? AND e.id>?))':'';
    const rows=db.prepare(`SELECT e.id,e.title,e.body_revision,f.title feed_title,COALESCE(e.published_at,e.fetched_at) date ${from}${cursor} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id LIMIT ?`).all(...args,...(input.cursor?[input.cursor.date,input.cursor.date,input.cursor.id]:[]),input.limit) as AIScanResult['rows'];
    return {matching,rows};
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
