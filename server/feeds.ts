import Parser from 'rss-parser';
import { createHash } from 'node:crypto';
import { isRecoveredFeed, type RivuDatabase, type EntryInput } from './database';
import { requestBytes } from './network';
import { applyEnabledRules } from './rules';
import { bodyImages, mediaKind, mediaUrl, uniqueMedia, type EntryMedia } from './media';
import { previewCustomJson, validateJsonMapping } from './custom-json';
import { scanNewsletterFolder } from './newsletter';
import { readSourceCandidate, type SourceAdapter } from './source-adapter';
import type {FeedWriteInput} from './feed-write-task';
import {feedWriteSnapshot} from './feed-write-task';
import type {MainWriteAccess} from './write-coordinator';

const parser = new Parser({ timeout: 15000, customFields: { feed:['icon','logo'],item: [['media:content','mediaContent'],['media:thumbnail','mediaThumbnail'],['itunes:image','itunesImage'],['content:encoded','fullContent']] } });
const MAX_BYTES=5_000_000;
function attributes(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object')return {};const object=value as Record<string,unknown>;return object.$&&typeof object.$==='object'?object.$ as Record<string,unknown>:object;}
function mediaItem(rawUrl:unknown,mime:unknown,source:EntryMedia['source'],base:string,medium?:unknown,title?:unknown):EntryMedia|null{
  const url=mediaUrl(rawUrl,base),kind=mediaKind(mime,rawUrl,medium);
  return url&&kind?{kind,url,mime:typeof mime==='string'?mime:null,source,title:typeof title==='string'?title.slice(0,200):null}:null;
}
function rssMedia(item:Record<string,unknown>,base:string,content:string,cover?:string){
  const result:EntryMedia[]=[];
  if(cover){const value=mediaItem(cover,'image/*','cover',base);if(value)result.push(value);}
  result.push(...bodyImages(content,base));
  for(const [field,source] of [['enclosure','enclosure'],['mediaContent','metadata'],['mediaThumbnail','metadata'],['itunesImage','metadata']] as const){
    for(const raw of Array.isArray(item[field])?item[field] as unknown[]:[item[field]]){
      const props=attributes(raw),value=mediaItem(props.url??props.href,props.type??(field==='mediaThumbnail'||field==='itunesImage'?'image/*':undefined),source,base,props.medium,props.title);
      if(value)result.push(value);
    }
  }
  return uniqueMedia(result);
}
export async function getText(url:string,privateOrigin?:string,authorize?:()=>void) {
  const response=await requestBytes(url,MAX_BYTES,'application/rss+xml, application/atom+xml, application/xml, text/xml, application/feed+json, text/html;q=0.8',privateOrigin,undefined,authorize);
  return {text:new TextDecoder().decode(response.bytes),url:response.url,type:response.type};
}
export type FeedPreview={title:string;url:string;siteUrl?:string;description?:string;icon?:string;items:EntryInput[]};
export type ParsedFeedPreview=FeedPreview&{sourceIcon?:string};
export type PagePreview=FeedPreview&{feedUrls:string[];iconUrls:string[];sourceIcon?:string};
export type FeedParseAccess={feed:(response:RssFetched,candidate:RssCandidate)=>Promise<ParsedFeedPreview>;page:(response:RssFetched,candidate:RssCandidate)=>Promise<PagePreview>};
async function previewIcon(raw:unknown,base:string,privateOrigin?:string,authorize?:()=>void){
  const url=mediaUrl(raw,base);if(!url)return undefined;
  try{
    const response=await requestBytes(url,256*1024,'image/png,image/jpeg,image/webp,image/gif,image/avif,image/x-icon,image/vnd.microsoft.icon',privateOrigin,undefined,authorize);
    const mime=response.type.split(';')[0].trim().toLowerCase();
    if(!['image/png','image/jpeg','image/webp','image/gif','image/avif','image/x-icon','image/vnd.microsoft.icon'].includes(mime)||!response.bytes.length)return undefined;
    return `data:${mime};base64,${response.bytes.toString('base64')}`;
  }catch{return undefined;}
}
export function sourceFeedCandidates(input:URL):string[]{
  if(input.protocol!=='https:'||input.port||input.username||input.password)return [];
  const parts=input.pathname.split('/').filter(Boolean);
  if(['github.com','www.github.com'].includes(input.hostname.toLowerCase())&&parts.length>=2&&parts.slice(0,2).every(part=>/^[A-Za-z0-9_.-]+$/.test(part))){
    const base=`https://github.com/${parts[0]}/${parts[1]}`;
    if(parts.length===2)return [`${base}/releases.atom`,`${base}/commits.atom`];
    if(parts[2]==='releases')return [`${base}/releases.atom`];
    if(parts[2]==='commits')return [`${base}/commits.atom`];
  }
  if(['youtube.com','www.youtube.com','m.youtube.com'].includes(input.hostname.toLowerCase())&&parts[0]==='channel'&&/^UC[A-Za-z0-9_-]{22}$/.test(parts[1]||''))
    return [`https://www.youtube.com/feeds/videos.xml?channel_id=${parts[1]}`];
  return [];
}
async function parsePublicCandidate(url:string,privateOrigin?:string,access?:FeedParseAccess){
  try{return await parseFeed(url,privateOrigin,true,access);}catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(!/请求超时|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|HTTP 50[0234]/i.test(message))throw error;
    await new Promise(resolve=>setTimeout(resolve,250));
    return parseFeed(url,privateOrigin,true,access);
  }
}
export type RssCandidate={url:string;privateOrigin?:string};
export type RssFetched=Awaited<ReturnType<typeof getText>>;
type RssParsed={response:RssFetched;data:Record<string,any>;format:'json'|'rss'};
export const rssSourceAdapter:SourceAdapter<RssCandidate,RssCandidate,RssFetched,RssParsed,FeedPreview>={
  id:'rss',
  async discover(input){return [{url:new URL(input.url).href,privateOrigin:input.privateOrigin}];},
  fetch(candidate){return getText(candidate.url,candidate.privateOrigin);},
  async parse(response){
    const body=response.text;
    if(response.type.includes('json')||body.trimStart().startsWith('{')){
      const data=JSON.parse(body);if(!String(data.version||'').includes('jsonfeed.org'))throw Error('不是有效 JSON Feed');
      return {response,data,format:'json'};
    }
    const data=await parser.parseString(body);if(!data.title&&!data.items.length)throw Error('未找到有效的 RSS/Atom 内容');
    return {response,data,format:'rss'};
  },
  normalize(parsed,candidate){
    const {response,data}=parsed,url=candidate.url;
    if(parsed.format==='json'){
    return {title:String(data.title||url),url:response.url,siteUrl:data.home_page_url,description:data.description,items:(data.items||[]).map((x:Record<string,unknown>)=>{
      const articleUrl=String(x.url||response.url),content=String(x.content_html||x.content_text||''),cover=String(x.image||x.banner_image||'');
      const media:EntryMedia[]=[];if(cover){const value=mediaItem(cover,'image/*','cover',articleUrl);if(value)media.push(value);}media.push(...bodyImages(content,articleUrl));
      for(const attachment of Array.isArray(x.attachments)?x.attachments:[]){const item=attributes(attachment),value=mediaItem(item.url,item.mime_type,'enclosure',articleUrl,undefined,item.title);if(value)media.push(value);}
      return {guid:String(x.id||x.url||''),title:String(x.title||'无标题'),author:String((x.author as {name?:string})?.name||''),url:String(x.url||''),publishedAt:String(x.date_published||''),content,description:String(x.summary||''),cover,media:uniqueMedia(media)};
    })};
    }
    const feed=data as Awaited<ReturnType<typeof parser.parseString>>;
  return {title:feed.title||url,url:response.url,siteUrl:feed.link,description:feed.description,items:feed.items.map(item=>{
    const extra=item as typeof item&{fullContent?:string;mediaContent?:unknown;mediaThumbnail?:unknown;itunesImage?:unknown};
    const content=extra.fullContent||item['content:encoded']||item.content||'',base=item.link||response.url;
    const thumbnail=attributes(extra.mediaThumbnail),itunes=attributes(extra.itunesImage);
    const cover=String(thumbnail.url??itunes.href??'');
    return {guid:item.guid||item.link,title:item.title||'无标题',author:item.creator,url:item.link,publishedAt:item.isoDate||item.pubDate,content,description:item.contentSnippet||item.summary,cover,media:rssMedia(extra as unknown as Record<string,unknown>,base,content,cover)};
  })};
  }
};
export async function parseFeedData(response:RssFetched,candidate:RssCandidate):Promise<ParsedFeedPreview>{
  const parsed=await rssSourceAdapter.parse(response,candidate);
  const raw=parsed.format==='json'?parsed.data.icon||parsed.data.favicon:parsed.data.image?.url||parsed.data.icon||parsed.data.logo;
  return {...rssSourceAdapter.normalize(parsed,candidate),...(typeof raw==='string'?{sourceIcon:raw}:{})};
}
export function parsePageData(response:RssFetched):PagePreview{
  const feedUrls:string[]=[],iconUrls:string[]=[];let sourceIcon:string|undefined;
  for(const match of response.text.matchAll(/<link\b[^>]*>/gi)){
    const tag=match[0],href=tag.match(/href\s*=\s*["']([^"']+)/i)?.[1];
    if(/rel\s*=\s*["'](?:shortcut\s+)?icon["']/i.test(tag)&&href){const icon=mediaUrl(href,response.url);if(icon){iconUrls.push(icon);if(!sourceIcon)sourceIcon=icon;}}
    if(!/rel\s*=\s*["']?alternate/i.test(tag)||!/application\/(rss\+xml|atom\+xml|feed\+json)/i.test(tag))continue;
    if(href)try{feedUrls.push(new URL(href,response.url).href);}catch{/* A malformed alternate link must not hide valid feeds or icons. */}
  }
  return {title:'',url:response.url,items:[],feedUrls,iconUrls,sourceIcon};
}
export async function parseFeed(url:string,privateOrigin?:string,includeIcon=false,access?:FeedParseAccess,authorize?:()=>void):Promise<FeedPreview>{
  const candidate=(await rssSourceAdapter.discover({url,privateOrigin}))[0];
  // Icons remain an optional preview enrichment; ordinary refresh never requests them.
  const fetched=await getText(candidate.url,candidate.privateOrigin,authorize),{sourceIcon,...preview}=await (access?access.feed(fetched,candidate):parseFeedData(fetched,candidate));
  if(includeIcon)preview.icon=await previewIcon(sourceIcon,fetched.url,privateOrigin,authorize);
  return preview;
}
export async function discoverFeeds(input:string,allowPrivate=false,access?:FeedParseAccess):Promise<FeedPreview[]>{
  const url=new URL(input.includes('://')?input:`https://${input}`);const candidates=[url.href];
  const privateOrigin=allowPrivate?url.origin:undefined;
  const special=sourceFeedCandidates(url);
  if(special.length){
    const results=await Promise.allSettled(special.map(candidate=>parsePublicCandidate(candidate,privateOrigin,access)));
    const found=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
    if(found.length)return found;
    const failure=results.find(result=>result.status==='rejected');
    if(failure?.status==='rejected'&&failure.reason?.resourceBusy)throw failure.reason;
    throw Error(`公开订阅源读取失败：${failure?.status==='rejected'&&failure.reason instanceof Error?failure.reason.message:'请检查网络连接或源地址'}`);
  }
  let html='',htmlUrl=url.href,initialFailure:unknown;try{const result=await getText(url.href,privateOrigin);html=result.text;htmlUrl=result.url;if(!/html/i.test(result.type)&&!html.trimStart().startsWith('<!DOCTYPE html'))return [await parseFeed(url.href,privateOrigin,true,access)];}catch(error){if((error as {resourceBusy?:boolean})?.resourceBusy)throw error;initialFailure=error;/* Try conventional paths below. */}
  const pageResponse={text:html,url:htmlUrl,type:'text/html'},page=await (access?access.page(pageResponse,{url:url.href,privateOrigin}):parsePageData(pageResponse)),pageIcon=page.sourceIcon;
  candidates.push(...page.feedUrls);
  for(const suffix of ['/feed','/rss','/atom.xml','/feed.xml'])candidates.push(new URL(suffix,url).href);
  const found:FeedPreview[]=[];for(const candidate of [...new Set(candidates)]){try{found.push(await parseFeed(candidate,privateOrigin,true,access));}catch(error){if((error as {resourceBusy?:boolean})?.resourceBusy)throw error;/* Other candidates may work. */}if(found.length>=5)break;}
  if(!found.length)throw Error('未发现 RSS、Atom 或 JSON Feed'+(initialFailure instanceof Error?`；初始地址检查失败：${initialFailure.message}`:''));
  if(pageIcon&&found.some(feed=>!feed.icon)){const icon=await previewIcon(pageIcon,htmlUrl,privateOrigin);for(const feed of found)if(!feed.icon)feed.icon=icon;}
  return found;
}
export async function refreshFeedIcon(db:RivuDatabase,id:string,access?:FeedParseAccess,wait:<T>(action:()=>Promise<T>)=>Promise<T>=async action=>action()){
  const feed=db.feed(id);
  if(!feed)throw Object.assign(Error('订阅不存在'),{statusCode:404});
  if(isRecoveredFeed(feed)||!['rss','rsshub'].includes(String(feed.type)))throw Object.assign(Error('此来源无法更新网站图标'),{statusCode:400});
  const url=String(feed.url),privateOrigin=feed.allow_private?new URL(url).origin:undefined;
  const authorize=()=>{
    const current=db.feed(id);
    if(!current)throw Object.assign(Error('订阅已删除'),{statusCode:404});
    if(['url','allow_private','type','enabled'].some(key=>current[key]!==feed[key]))throw Object.assign(Error('来源或网络授权已变化，请重新更新图标'),{statusCode:409});
  };
  const icon=await wait(async()=>{
  const preview=await parseFeed(url,privateOrigin,true,access,authorize);
  let icon=preview.icon;
  if(!icon&&preview.siteUrl){
    try{
      const site=mediaUrl(preview.siteUrl,url);
      if(site){
        const page=await getText(site,privateOrigin,authorize);
        if(/html/i.test(page.type)){const metadata=await (access?access.page(page,{url:site,privateOrigin}):parsePageData(page));for(const href of metadata.iconUrls){icon=await previewIcon(href,page.url,privateOrigin,authorize);if(icon)break;}}
      }
    }catch{/* Keep the existing local snapshot when website metadata is unavailable. */}
  }
  return icon;
  });
  authorize();
  if(!icon)throw Object.assign(Error('未找到可用图标，已保留原图标'),{statusCode:422});
  db.db.prepare('UPDATE feeds SET icon=? WHERE id=?').run(icon,id);
  return {updated:true};
}
export async function refreshFeed(db:RivuDatabase,id:string,parseSource?:(response:RssFetched,candidate:RssCandidate)=>Promise<FeedPreview>,writeBatch?:(input:FeedWriteInput)=>Promise<{added:number;total:number}>,withMain:MainWriteAccess=async action=>action(),parseJsonSource?:Parameters<typeof previewCustomJson>[1],parseNewsletter?:Parameters<typeof scanNewsletterFolder>[2]){
  const feed=db.feed(id);if(!feed)throw Error('订阅不存在');
  if(isRecoveredFeed(feed))throw Object.assign(Error('原订阅地址缺失，无法刷新；请重新添加原订阅'),{statusCode:400});
  try{
    if(feed.type==='newsletter'){
      const result=await scanNewsletterFolder(db,id,parseNewsletter,writeBatch);
      if(writeBatch)return {added:result.added,total:result.total};
      applyEnabledRules(db,id);
      db.markFetch(id);
      if(result.failed)db.db.prepare('UPDATE feeds SET last_error=? WHERE id=?').run(`${result.failed} 个 .eml 文件无法导入，请检查大小或格式`,id);
      return {added:result.added,total:result.total};
    }
    const url=String(feed.url);
    const candidate={url,privateOrigin:feed.allow_private?new URL(url).origin:undefined};
    const data=feed.type==='custom_json'?await previewCustomJson({url,title:String(feed.title),mapping:validateJsonMapping(JSON.parse(String(feed.json_mapping))),allowPrivate:!!feed.allow_private},parseJsonSource):parseSource?await parseSource(await rssSourceAdapter.fetch(candidate),candidate):await readSourceCandidate(rssSourceAdapter,candidate);
    if(writeBatch)return await writeBatch({databasePath:db.path,expected:feedWriteSnapshot(feed),items:data.items});
    const entries=data.items.map(item=>({...item,hash:createHash('sha256').update(item.guid||item.url||`${item.title}\n${item.content||item.description||''}`).digest('hex')}));
    const added=db.addEntries(id,entries);applyEnabledRules(db,id);db.markFetch(id);
    return {added,total:entries.length};
  }catch(error){await withMain(()=>{
    if((error as {resourceBusy?:boolean})?.resourceBusy)return;
    const current=db.feed(id);
    // A stale source failure must not alter the health of a newly authorized source.
    if(current&&JSON.stringify(feedWriteSnapshot(current))===JSON.stringify(feedWriteSnapshot(feed)))db.markFetch(id,error instanceof Error?error.message:String(error));
  });throw error;}
}
