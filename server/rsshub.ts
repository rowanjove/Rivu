import type { RivuDatabase } from './database';
import { parseFeed, refreshFeed, type FeedParseAccess } from './feeds';

export function normalizeRsshubBase(input:string){const url=new URL(input.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('RSSHub 实例地址应为 HTTP/HTTPS 根地址');return url.origin;}
export function rsshubRouteUrl(db:RivuDatabase,instanceId:string,route:string){const instance=db.rsshubInstance(instanceId);if(!instance)throw Error('RSSHub 实例不存在');if(!instance.enabled)throw Error('RSSHub 实例已停用');if(!/^\/(?!\/)[^\s]*$/.test(route))throw Error('请输入以单斜杠开头的 RSSHub 路由');const base=new URL(instance.base_url);const resolved=new URL(route,base);if(resolved.origin!==base.origin)throw Error('RSSHub 路由不能离开当前实例');return resolved.href;}
function assertInstance(db:RivuDatabase,instanceId:string,expected:NonNullable<ReturnType<RivuDatabase['rsshubInstance']>>){
  const current=db.rsshubInstance(instanceId);
  if(!current)throw Object.assign(Error('RSSHub 实例已删除'),{statusCode:404});
  if((['base_url','enabled','allow_private'] as const).some(key=>current[key]!==expected[key]))throw Object.assign(Error('RSSHub 地址或网络授权已变化，请重新预览'),{statusCode:409});
  return current;
}
export async function previewRsshub(db:RivuDatabase,instanceId:string,route:string,access?:FeedParseAccess){
  const url=rsshubRouteUrl(db,instanceId,route),instance=db.rsshubInstance(instanceId)!;
  const preview=await parseFeed(url,instance.allow_private?new URL(url).origin:undefined,true,access,()=>{assertInstance(db,instanceId,instance);});
  assertInstance(db,instanceId,instance);return preview;
}
export async function subscribeRsshub(db:RivuDatabase,instanceId:string,route:string,categoryId?:string,fetchInterval?:number,access?:FeedParseAccess,refresh?:(id:string)=>Promise<unknown>,wait:<T>(action:()=>Promise<T>)=>Promise<T>=async action=>action()){
  rsshubRouteUrl(db,instanceId,route);const expected=db.rsshubInstance(instanceId)!;
  const preview=await wait(()=>previewRsshub(db,instanceId,route,access));
  const instance=assertInstance(db,instanceId,expected);
  const feed=db.addFeed({...preview,type:'rsshub',rsshubInstanceId:instanceId,categoryId,fetchInterval,allowPrivate:!!instance.allow_private});
  try{if(refresh)await refresh(String(feed?.id));else await refreshFeed(db,String(feed?.id));}catch{/* Feed remains for retry. */}
  return db.feed(String(feed?.id));
}
