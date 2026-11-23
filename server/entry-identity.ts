import { createHash } from 'node:crypto';

export type Identity={kind:'hash'|'guid'|'url'|'canonical'|'content';value:string};
export type IdentityInput={hash:string;guid?:string|null;url?:string|null;canonicalUrl?:string;title:string;author?:string|null;content?:string|null;description?:string|null};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function normalizedEntryUrl(raw:unknown,base?:string,removeTracking=false){
  if(typeof raw!=='string'||!raw.trim()||raw.length>8192)return undefined;
  try{
    const url=new URL(raw,base);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return undefined;
    url.hash='';
    if(removeTracking)for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||/^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key))url.searchParams.delete(key);
    return url.href;
  }catch{return undefined;}
}
export function declaredCanonical(raw:unknown,articleUrl?:string,base?:string){
  const article=normalizedEntryUrl(articleUrl,base),canonical=normalizedEntryUrl(raw,article||base,true);
  // A declaration never grants network access or joins unrelated publisher origins.
  return article&&canonical&&new URL(article).origin===new URL(canonical).origin?canonical:undefined;
}
export function entryIdentities(input:IdentityInput,base?:string):Identity[]{
  const result:Identity[]=[{kind:'hash',value:input.hash}];
  if(input.guid?.trim())result.push({kind:'guid',value:digest(input.guid.trim())});
  const url=normalizedEntryUrl(input.url,base),canonical=normalizedEntryUrl(input.url,base,true),declared=declaredCanonical(input.canonicalUrl,input.url||undefined,base);
  if(url)result.push({kind:'url',value:url});
  for(const value of new Set([canonical,declared]))if(value)result.push({kind:'canonical',value});
  const body=input.content||input.description;
  if(body?.trim())result.push({kind:'content',value:digest(JSON.stringify([input.title.trim(),input.author?.trim()||'',body]))});
  return result;
}
