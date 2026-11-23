import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { RivuDatabase } from './database';
import { getText } from './feeds';
import type { RssFetched } from './feeds';
import {assertEntrySourceUnchanged,entrySourceSnapshot} from './entry-source';
export {assertEntrySourceUnchanged} from './entry-source';
import type {FullTextWriteInput} from './feed-write-task';

export type FullTextResult={html:string;canonicalUrl:string};
export type FullTextParser=(response:RssFetched)=>Promise<FullTextResult>;

export function extractFullText(response:RssFetched):FullTextResult{
  if(!/html/i.test(response.type)&&!/<(?:html|article|main|body)\b/i.test(response.text))throw Error('原文不是 HTML 页面');
  const page=new JSDOM(response.text,{url:response.url});
  let canonicalUrl=response.url,parsed:ReturnType<Readability['parse']>;
  try{
    const canonicalHref=page.window.document.querySelector('link[rel~="canonical"][href]')?.getAttribute('href');
    try{if(canonicalHref)canonicalUrl=new URL(canonicalHref,response.url).href;}catch{}
    parsed=new Readability(page.window.document).parse();
  }finally{page.window.close();}
  if(!parsed?.content||!parsed.textContent?.trim())throw Error('未能从原文提取可读正文');
  const article=new JSDOM(parsed.content,{url:response.url});
  try{const document=article.window.document;
  document.querySelectorAll('script,style,iframe,object,embed,form').forEach(node=>node.remove());
  for(const el of document.querySelectorAll<HTMLElement>('[href],[src]')){
    for(const attr of ['href','src']){const value=el.getAttribute(attr);if(!value)continue;try{const resolved=new URL(value,response.url);if(!['http:','https:'].includes(resolved.protocol))el.removeAttribute(attr);else el.setAttribute(attr,resolved.href);}catch{el.removeAttribute(attr);}}
  }
    return {html:document.body.innerHTML,canonicalUrl};
  }finally{article.window.close();}
}
export async function fetchFullText(db:RivuDatabase,entryId:string,parse?:FullTextParser,write?:(input:FullTextWriteInput)=>Promise<unknown>){
  const entry=db.entry(entryId);
  if(!entry)throw Error('文章不存在');
  if(!entry.url)throw Error('这篇文章没有原文地址');
  const feedOrigin=entry.feed_allow_private&&entry.feed_url?new URL(String(entry.feed_url)).origin:undefined;
  const response=await getText(String(entry.url),feedOrigin);
  const {html,canonicalUrl}=await (parse?parse(response):extractFullText(response));
  assertEntrySourceUnchanged(db,entryId,entry);
  if(write){await write({kind:'full_text',databasePath:db.path,entryId,expected:entrySourceSnapshot(entry),html,canonicalUrl});return db.entry(entryId);}
  return db.setFullContent(entryId,html,canonicalUrl);
}
