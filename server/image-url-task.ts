import {parse,type DefaultTreeAdapterTypes} from 'parse5';
import type {RssFetched,RssCandidate} from './feeds';
import {resolveArticleImageUrl} from './image-url-shape';

// Match JSDOM's non-executing document parse, without constructing a Window or
// loading the RSS/full-text stack. Template contents are separate trees and are
// deliberately not visited, just like document.querySelectorAll('img[src]').
export function parseImageUrls(response:RssFetched,candidate:RssCandidate&{cover?:string}){
  const document=parse(response.text,{scriptingEnabled:false}),urls=new Set<string>();
  const add=(value:string|undefined)=>{
    const url=resolveArticleImageUrl(value,candidate.url);if(url)urls.add(url);
  };
  add(candidate.cover);
  const stack:DefaultTreeAdapterTypes.Node[]=[document];
  while(stack.length){
    const node=stack.pop()!;
    if('tagName' in node&&node.tagName==='img')add(node.attrs.find(attribute=>attribute.name==='src'&&!attribute.namespace)?.value);
    if('childNodes' in node)for(let index=node.childNodes.length-1;index>=0;index--)stack.push(node.childNodes[index]);
  }
  return [...urls];
}
