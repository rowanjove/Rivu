import {api} from './api';

export function createSourceIconCache(load:(feedId:string,key:string)=>Promise<string>,options={maxEntries:64,maxChars:8_000_000,concurrency:6}){
  const cache=new Map<string,string>(),pending=new Map<string,Promise<string>>();
  const queue:(()=>void)[]=[];let active=0,chars=0;
  const drain=()=>{while(active<options.concurrency&&queue.length)queue.shift()!();};
  return {
    get(feedId:string,key:string):Promise<string>{
      const id=`${feedId}:${key}`,hit=cache.get(id);
      if(hit){cache.delete(id);cache.set(id,hit);return Promise.resolve(hit);}
      const running=pending.get(id);if(running)return running;
      let resolve!:(value:string)=>void,reject!:(error:unknown)=>void;
      const promise=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});pending.set(id,promise);
      queue.push(()=>{
        active++;
        void Promise.resolve().then(()=>load(feedId,key)).then(value=>{
          if(value.length<=options.maxChars){
            cache.set(id,value);chars+=value.length;
            while(cache.size>options.maxEntries||chars>options.maxChars){const oldest=cache.keys().next().value!;chars-=cache.get(oldest)!.length;cache.delete(oldest);}
          }
          resolve(value);
        },reject).finally(()=>{pending.delete(id);active--;drain();});
      });drain();return promise;
    }
  };
}

const cache=createSourceIconCache(async(feedId,key)=>{
  const result=await api.get<{icon:string}>(`/api/feeds/${encodeURIComponent(feedId)}/icon-snapshot?key=${key}`);
  if(typeof result.icon!=='string'||result.icon.length>350_000||!/^data:image\/(?:png|jpeg|webp|gif|avif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/.test(result.icon))throw Error('本地图标快照无效');
  return result.icon;
});
export const getSourceIcon=cache.get;
