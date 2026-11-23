import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { getProxyForUrl } from 'proxy-from-env';

type ResolvedAddress={address:string;family:number};
type ResolveHost=(hostname:string,options:{all:true;verbatim:true})=>Promise<ResolvedAddress[]>;
export type ProxyPreferences={mode:'environment'|'direct'|'custom';httpProxy:string;httpsProxy:string;noProxy:string};
let proxyPreferences:ProxyPreferences={mode:'environment',httpProxy:'',httpsProxy:'',noProxy:''};
let proxyUnavailable:string|null=null;
export function setProxyPreferences(value:ProxyPreferences,unavailable?:string){proxyPreferences={...value};proxyUnavailable=unavailable||null;}
const directHttpAgent=new HttpAgent({proxyEnv:{}} as ConstructorParameters<typeof HttpAgent>[0]);
const directHttpsAgent=new HttpsAgent({proxyEnv:{}} as ConstructorParameters<typeof HttpsAgent>[0]);
const DNS_TIMEOUT_MS=15_000;

async function resolveAddresses(hostname:string,resolveHost:ResolveHost,signal?:AbortSignal){
  let timer:ReturnType<typeof setTimeout>|undefined;
  let aborted:(()=>void)|undefined;
  try{return await Promise.race([
    resolveHost(hostname,{all:true,verbatim:true}),
    new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('请求超时（DNS 解析）')),DNS_TIMEOUT_MS);}),
    ...(signal?[new Promise<never>((_resolve,reject)=>{aborted=()=>reject(signal.reason??Error('请求已中止'));signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();})]:[]),
  ]);}finally{if(timer)clearTimeout(timer);if(aborted)signal?.removeEventListener('abort',aborted);}
}

function bypassCustomProxy(url:URL,patterns:string){
  const hostname=url.hostname.toLowerCase(),port=Number(url.port)||Number(url.protocol==='https:'?443:80);
  for(const item of patterns.toLowerCase().split(/[,\s]+/).filter(Boolean)){
    if(item==='*')return true;
    const match=item.match(/^(.+):(\d+)$/),pattern=match?match[1]:item;
    if(match&&Number(match[2])!==port)continue;
    if(pattern.startsWith('*.')||pattern.startsWith('.')){if(hostname.endsWith(pattern.startsWith('*')?pattern.slice(1):pattern))return true;}
    else if(hostname===pattern)return true;
  }
  return false;
}
export function proxyForRequest(url:URL,preferences:ProxyPreferences=proxyPreferences):URL|null{
  if(preferences.mode==='direct')return null;
  const raw=preferences.mode==='environment'?getProxyForUrl(url):bypassCustomProxy(url,preferences.noProxy)?'':url.protocol==='https:'?preferences.httpsProxy:preferences.httpProxy;
  if(!raw)return null;
  try{
    const proxy=new URL(raw);
    if(!['http:','https:'].includes(proxy.protocol)||proxy.hash||proxy.search||proxy.pathname!=='/')throw Error('invalid');
    return proxy;
  }catch{throw Error('代理配置无效');}
}

export function privateAddress(address:string):boolean{
  const ip=address.toLowerCase().split('%')[0];
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===192&&b===0)||(a===198&&[18,19].includes(b));}
  if(isIP(ip)===6){
    // URL canonicalization collapses equivalent IPv6 spellings, including expanded loopback.
    const canonical=new URL(`http://[${ip}]`).hostname.slice(1,-1);
    const mapped=canonical.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);if(mapped)return privateAddress(mapped[1]);
    const hexMapped=canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if(hexMapped){const a=parseInt(hexMapped[1],16),b=parseInt(hexMapped[2],16);return privateAddress(`${a>>8}.${a&255}.${b>>8}.${b&255}`);}
    if(canonical==='::'||canonical==='::1'||canonical.startsWith('2002:')||canonical.startsWith('2001:db8:'))return true;
    // Only global unicast is suitable for automatic public feed requests.
    return !/^[23][0-9a-f]{3}:/.test(canonical);
  }
  return true;
}

export async function requestBytes(raw:string,maxBytes:number,accept:string,privateOrigin?:string,resolveHost:ResolveHost=lookup,authorize?:()=>void,signal?:AbortSignal){
  let current=new URL(raw);
  const requestProxyPreferences={...proxyPreferences};
  const requestProxyUnavailable=proxyUnavailable;
  for(let redirects=0;redirects<=5;redirects++){
    signal?.throwIfAborted();
    authorize?.();
    if(!['http:','https:'].includes(current.protocol)||current.username||current.password)throw Error('仅支持 HTTP/HTTPS 地址');
    const literalHost=current.hostname.replace(/^\[|\]$/g,'');
    const trustedLocal=current.origin===privateOrigin&&(literalHost==='localhost'||isIP(literalHost)!==0);
    const proxyBypassAllowed=trustedLocal&&(literalHost==='localhost'||privateAddress(literalHost));
    const assertProxyAvailable=()=>{if(!proxyBypassAllowed&&(requestProxyUnavailable||proxyUnavailable))throw Error(requestProxyUnavailable||proxyUnavailable!);};
    assertProxyAvailable();
    const addresses=await resolveAddresses(current.hostname,resolveHost,signal);
    signal?.throwIfAborted();
    assertProxyAvailable();
    if(literalHost==='localhost'&&addresses.some(x=>!privateAddress(x.address)))throw Error('localhost 解析结果不是本机地址');
    if(!addresses.length||addresses.some(x=>privateAddress(x.address))&&!trustedLocal)throw Error('禁止访问本机或内网地址');
    const selected=addresses[0];
    const proxy=trustedLocal?null:proxyForRequest(current,requestProxyPreferences);
    const proxyHttp=proxy&&current.protocol==='http:';
    const headers:Record<string,string>={'User-Agent':'Rivu/0.2 (+local reader)',Accept:accept};
    if(proxy){headers.Host=current.host;}
    if(proxyHttp&&(proxy.username||proxy.password)){
      try{headers['Proxy-Authorization']='Basic '+Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');}
      catch{throw Error('代理配置无效');}
    }
    let agent:HttpsAgent|undefined;
    if(proxy&&current.protocol==='https:')try{
      agent=new HttpsAgent({proxyEnv:{HTTPS_PROXY:proxy.href,NO_PROXY:''}} as ConstructorParameters<typeof HttpsAgent>[0]);
    }catch{throw Error('代理配置无效');}
    const connection=proxyHttp?new URL(proxy.origin):current;
    const pinnedUrl=proxyHttp?new URL(current.href):null;
    if(pinnedUrl)pinnedUrl.hostname=selected.family===6?`[${selected.address}]`:selected.address;
    const result=await new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;bytes:Buffer}>((resolve,reject)=>{
      authorize?.();
      try{assertProxyAvailable();}catch(cause){reject(cause);return;}
      let phase='连接';
      const requestOptions={method:'GET',headers,timeout:15000,signal,...(pinnedUrl?{path:pinnedUrl.href}:{}),...(agent?{hostname:selected.address,servername:current.hostname}:{}),agent:agent??(connection.protocol==='https:'?directHttpsAgent:directHttpAgent),...(proxy?{}:{lookup:(_host:string,options:LookupOptions,callback:(error:NodeJS.ErrnoException|null,address:string|LookupAddress[],family?:number)=>void)=>options.all?callback(null,addresses):callback(null,selected.address,selected.family)})};
      const req=(connection.protocol==='https:'?httpsRequest:httpRequest)(connection,requestOptions,res=>{
        phase='接收响应';
        const chunks:Buffer[]=[];let total=0;
        if(Number(res.headers['content-length']||0)>maxBytes){res.destroy();reject(Error('响应超过大小限制'));return;}
        res.on('data',(chunk:Buffer)=>{phase='接收正文';total+=chunk.length;if(total>maxBytes){res.destroy();reject(Error('响应超过大小限制'));}else chunks.push(chunk);});
        res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,bytes:Buffer.concat(chunks)}));res.on('error',reject);
      });req.on('socket',socket=>{
        if(!socket.connecting){phase='等待响应';return;}
        const connected=()=>{phase=current.protocol==='https:'?'TLS 握手':'等待响应';};
        const secured=()=>{phase='等待响应';};
        socket.once('connect',connected);socket.once('secureConnect',secured);
        req.once('close',()=>{socket.off('connect',connected);socket.off('secureConnect',secured);});
      });req.on('timeout',()=>req.destroy(Error(`请求超时（${phase}）`)));req.on('error',reject);req.end();
    }).finally(()=>agent?.destroy());
    signal?.throwIfAborted();
    if([301,302,303,307,308].includes(result.status)&&result.headers.location){current=new URL(result.headers.location,current);continue;}
    if(result.status<200||result.status>=300)throw Error(`HTTP ${result.status}`);
    return {bytes:result.bytes,url:current.href,type:String(result.headers['content-type']||'')};
  }
  throw Error('重定向次数过多');
}
