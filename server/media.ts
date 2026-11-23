import { JSDOM } from 'jsdom';

export type MediaKind='image'|'audio'|'video';
export type MediaSource='cover'|'body'|'enclosure'|'metadata';
export type EntryMedia={kind:MediaKind;url:string;mime:string|null;source:MediaSource;title:string|null};

export function mediaUrl(raw:unknown,base?:string){
  if(typeof raw!=='string'||!raw.trim())return null;
  try{const url=new URL(raw.trim(),base);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function mediaKind(rawMime:unknown,rawUrl:unknown,medium?:unknown):MediaKind|null{
  const mime=typeof rawMime==='string'?rawMime.toLowerCase().split(';')[0].trim():'';
  const declared=typeof medium==='string'?medium.toLowerCase():'';
  if(mime.startsWith('image/')||declared==='image')return 'image';
  if(mime.startsWith('audio/')||declared==='audio')return 'audio';
  if(mime.startsWith('video/')||declared==='video')return 'video';
  if(typeof rawUrl==='string'){
    try{const ext=new URL(rawUrl,'https://example.invalid').pathname.toLowerCase();if(/\.(png|jpe?g|webp|gif|avif)$/.test(ext))return 'image';if(/\.(mp3|m4a|aac|ogg|opus|wav|flac)$/.test(ext))return 'audio';if(/\.(mp4|webm|m4v|mov)$/.test(ext))return 'video';}catch{}
  }
  return null;
}
export function bodyImages(html:string,base?:string):EntryMedia[]{
  if(!html||!/<img\b/i.test(html))return [];
  const document=JSDOM.fragment(html),result:EntryMedia[]=[],seen=new Set<string>();
  for(const image of document.querySelectorAll('img[src]')){
    const url=mediaUrl(image.getAttribute('src'),base);if(!url||seen.has(url))continue;seen.add(url);
    result.push({kind:'image',url,mime:null,source:'body',title:image.getAttribute('alt')?.trim().slice(0,200)||null});if(result.length>=50)break;
  }
  return result;
}
export function uniqueMedia(items:EntryMedia[]){const seen=new Set<string>();return items.filter(item=>{const key=`${item.kind}:${item.url}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,60);}
