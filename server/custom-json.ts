import { requestBytes } from './network';
import { bodyImages, uniqueMedia, type EntryMedia } from './media';
import type { EntryInput } from './database';
import { discoverSource, type SourceAdapter } from './source-adapter';

export type JsonMapping={itemsPath:string;titlePath:string;idPath:string;urlPath:string;datePath:string;contentPath:string;summaryPath:string;authorPath:string;imagePath:string};
const fields=['itemsPath','titlePath','idPath','urlPath','datePath','contentPath','summaryPath','authorPath','imagePath'] as const;
const invalid=(message:string)=>Object.assign(Error(message),{statusCode:400});
const forbidden=new Set(['__proto__','prototype','constructor']);
function pathParts(raw:string){
  if(!raw||raw==='$')return [];
  const parts=raw.split('.');
  if(parts.length>8||parts.some(part=>!part||part.length>80||forbidden.has(part)))throw invalid('JSON 字段路径无效');
  return parts;
}
function field(value:unknown,required=false){
  if(typeof value!=='string'||value.length>400)throw invalid('JSON 字段路径无效');
  const result=value.trim();
  if(required&&!result)throw invalid('文章数组和标题路径不能为空');
  pathParts(result);
  return result;
}
export function validateJsonMapping(value:unknown):JsonMapping{
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid('JSON 字段映射无效');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!fields.includes(key as typeof fields[number])))throw invalid('JSON 字段映射含未知字段');
  const result={} as JsonMapping;
  for(const key of fields)result[key]=field(input[key]??'',key==='itemsPath'||key==='titlePath');
  if(!result.idPath&&!result.urlPath)throw invalid('文章 ID 或链接路径至少填写一项');
  return result;
}
function at(value:unknown,path:string):unknown{
  let current=value;
  for(const part of pathParts(path)){
    if(!current||typeof current!=='object'||!Object.hasOwn(current,part))return undefined;
    current=(current as Record<string,unknown>)[part];
  }
  return current;
}
function plain(value:unknown,max=200_000){return typeof value==='string'?value.slice(0,max):typeof value==='number'&&Number.isFinite(value)?String(value):'';}
function optionalUrl(value:unknown,base:string){
  const raw=plain(value,4000);if(!raw)return '';
  try{const url=new URL(raw,base);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
export type JsonInput={url:string;title:string;mapping:unknown;allowPrivate?:boolean};
export type JsonCandidate={url:string;title:string;mapping:JsonMapping;privateOrigin?:string};
export type JsonFetched=Awaited<ReturnType<typeof requestBytes>>;
export type JsonPreview={title:string;url:string;items:EntryInput[];skipped:number;mapping:JsonMapping};
type JsonParsed={data:unknown;response:JsonFetched};
export const customJsonSourceAdapter:SourceAdapter<JsonInput,JsonCandidate,JsonFetched,JsonParsed,JsonPreview>={
  id:'custom_json',
  async discover(input){
  if(!input||typeof input.url!=='string'||typeof input.title!=='string'||!input.title.trim()||input.title.length>200)throw invalid('来源名称无效');
  let source:URL;
  try{source=new URL(input.url);}catch{throw invalid('JSON API 地址无效');}
  if(!['http:','https:'].includes(source.protocol)||source.username||source.password||source.hash)throw invalid('仅支持不含凭据和片段的 HTTP/HTTPS 地址');
  const mapping=validateJsonMapping(input.mapping);

    return [{url:source.href,title:input.title.trim(),mapping,privateOrigin:input.allowPrivate?source.origin:undefined}];
  },
  fetch(candidate){return requestBytes(candidate.url,5_000_000,'application/json, application/*+json;q=0.9',candidate.privateOrigin);},
  async parse(response){
    let data:unknown;
    try{data=JSON.parse(new TextDecoder().decode(response.bytes));}catch{throw invalid('接口响应不是有效 JSON');}
    return {data,response};
  },
  normalize(parsed,candidate){
  const {data,response}=parsed,{mapping}=candidate;
  const rows=at(data,mapping.itemsPath);
  if(!Array.isArray(rows))throw invalid('文章数组路径未指向数组');
  if(rows.length>1000)throw invalid('单次接口返回超过 1000 篇文章，请缩小接口结果');
  const items:EntryInput[]=[];
  for(const row of rows){
    const title=plain(at(row,mapping.titlePath),1000).trim();
    const guid=plain(at(row,mapping.idPath),4000).trim();
    const url=optionalUrl(at(row,mapping.urlPath),response.url);
    if(!title||(!guid&&!url))continue;
    const rawDate=at(row,mapping.datePath);let publishedAt='';
    if(typeof rawDate==='number'&&Number.isFinite(rawDate)){const date=new Date(rawDate>1e11?rawDate:rawDate*1000);if(!Number.isNaN(date.getTime()))publishedAt=date.toISOString();}
    else{const date=plain(rawDate,100);if(date&&!Number.isNaN(Date.parse(date)))publishedAt=new Date(date).toISOString();}
    const content=plain(at(row,mapping.contentPath));
    const cover=optionalUrl(at(row,mapping.imagePath),url||response.url);
    const media:EntryMedia[]=[];
    if(cover)media.push({kind:'image',url:cover,mime:null,source:'cover',title:null});
    media.push(...bodyImages(content,url||response.url));
    items.push({guid:guid||url,title,url,author:plain(at(row,mapping.authorPath),500),publishedAt,content,description:plain(at(row,mapping.summaryPath),4000),cover,media:uniqueMedia(media)});
  }
  if(rows.length&&items.length===0)throw invalid('映射未提取到有效文章：检查标题及 ID 或链接路径');
  return {title:candidate.title,url:candidate.url,items,skipped:rows.length-items.length,mapping};
  }
};
export async function previewCustomJson(input:JsonInput,parseSource?:(response:JsonFetched,candidate:JsonCandidate)=>Promise<JsonPreview>,authorize?:()=>void){
  if(!parseSource&&!authorize)return (await discoverSource(customJsonSourceAdapter,input))[0];
  const candidate=(await customJsonSourceAdapter.discover(input))[0];
  const response=await requestBytes(candidate.url,5_000_000,'application/json, application/*+json;q=0.9',candidate.privateOrigin,undefined,authorize);
  const preview=parseSource?await parseSource(response,candidate):customJsonSourceAdapter.normalize(await customJsonSourceAdapter.parse(response,candidate),candidate);
  authorize?.();return preview;
}
