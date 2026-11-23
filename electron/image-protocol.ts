import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';

type Endpoint={baseUrl:string;token:string};
type FetchImage=(url:string,options:RequestInit)=>Promise<Response>;
type ImageRequest={url:string;method:string;initiatorOrigin?:string|null;signal?:AbortSignal};
export type NativeImageRead=(entryId:string,url:string,mode:'lookup'|'load',signal?:AbortSignal)=>Promise<{image:{data:Buffer;mime:string}|null;authorize:()=>void}>;
const MAX=8*1024*1024;
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const denied=(status:number)=>new Response(null,{status,headers});

export class NativeImageProtocol{
  private endpoint:Endpoint|null=null;
  private capability=randomBytes(32).toString('hex');
  private epoch=0;
  private serial=0;
  private active=new Set<AbortController>();
  private byteReads=new Set<AbortController>();
  private resources=new Map<string,Set<AbortController>>();
  private revoked=new Set<string>();
  private resourceKey(raw:string){return createHash('sha256').update(new URL(raw).href).digest('hex');}
  constructor(private fetchImage:FetchImage,private origin:string,private timeoutMs=120000){if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('图片超时参数无效');}
  rotate(){this.epoch++;this.capability=randomBytes(32).toString('hex');for(const controller of this.active)controller.abort();for(const controller of this.byteReads)controller.abort();this.active.clear();this.resources.clear();this.revoked.clear();}
  cancel(raw:string){
    if(typeof raw!=='string'||raw.length>100000)return;
    try{
      const url=new URL(raw),keys=[...url.searchParams.keys()],v=url.searchParams.get('v')||'';
      if(url.protocol!=='rivu-image:'||url.host!=='local'||url.username||url.password||url.hash||!['/lookup','/load'].includes(url.pathname)||keys.length!==4||new Set(keys).size!==4||keys.some(key=>!['entryId','url','cap','v'].includes(key))||url.searchParams.get('cap')!==this.capability||!/^\d{1,16}$/.test(v)||Number(v)<1||Number(v)>this.serial)return;
      this.validate(url.searchParams.get('entryId')!,url.searchParams.get('url')!);
      const key=this.resourceKey(raw);
      if(!this.revoked.has(key)&&this.revoked.size>=4096){this.rotate();return;}
      this.revoked.add(key);for(const controller of this.resources.get(key)||[])controller.abort();
    }catch{/* Malformed or stale cancellation cannot affect current resources. */}
  }
  setEndpoint(endpoint:Endpoint|null){
    this.rotate();this.endpoint=null;
    if(endpoint){const url=new URL(endpoint.baseUrl);if(url.origin!==endpoint.baseUrl||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||!endpoint.token)throw Error('本地图片服务地址无效');}
    this.endpoint=endpoint?{...endpoint}:null;
  }
  url(entryId:string,raw:string,mode:'lookup'|'load'='load'){
    if(!this.endpoint)throw Error('图片服务暂不可用');
    this.validate(entryId,raw);if(mode!=='lookup'&&mode!=='load')throw Error('图片操作无效');
    const url=new URL('rivu-image://local/'+mode);url.search=new URLSearchParams({entryId,url:raw,cap:this.capability,v:String(++this.serial)}).toString();return url.href;
  }
  private validate(entryId:string,raw:string){
    if(typeof entryId!=='string'||!entryId||entryId.length>200||typeof raw!=='string'||raw.length>8192)throw Error('图片参数无效');
    const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('图片地址无效');
  }
  private parse(request:ImageRequest):URL|null{
    let url:URL;
    try{
      if(typeof request.url!=='string'||request.url.length>100000||!/^rivu-image:\/\/local\/(?:lookup|load)\?/.test(request.url))return null;
      url=new URL(request.url);
      if(request.method!=='GET'||url.protocol!=='rivu-image:'||url.host!=='local'||url.username||url.password||url.hash||!['/lookup','/load'].includes(url.pathname))return null;
      const origin=request.initiatorOrigin;
      if(origin===undefined||(this.origin==='null'?origin!==null&&origin!=='null':origin!==this.origin))return null;
      const keys=[...url.searchParams.keys()];if(keys.length!==4||new Set(keys).size!==4||keys.some(key=>!['entryId','url','cap','v'].includes(key)))return null;
      const cap=url.searchParams.get('cap')||'';if(cap.length!==64||!timingSafeEqual(Buffer.from(cap),Buffer.from(this.capability)))return null;
      this.validate(url.searchParams.get('entryId')!,url.searchParams.get('url')!);
      const serial=url.searchParams.get('v')||'';if(!/^\d{1,16}$/.test(serial)||Number(serial)<1||Number(serial)>this.serial)return null;
      return url;
    }catch{return null;}
  }
  async readBytes(request:ImageRequest,read:NativeImageRead,assertRecipient:()=>void){
    const fail=(statusCode:number)=>Object.assign(Error('图片原字节读取失败'),{statusCode});
    const url=this.parse(request);if(!url)throw fail(403);
    const endpoint=this.endpoint,epoch=this.epoch,key=this.resourceKey(request.url);
    if(!endpoint||this.revoked.has(key)||request.signal?.aborted)throw fail(503);
    if(this.active.size+this.byteReads.size>=16)throw fail(429);
    const controller=new AbortController();this.byteReads.add(controller);
    const resource=this.resources.get(key)||new Set<AbortController>();resource.add(controller);this.resources.set(key,resource);
    const abort=()=>controller.abort();request.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,this.timeoutMs);timer.unref();
    const current=()=>{if(controller.signal.aborted||this.epoch!==epoch||this.endpoint!==endpoint||this.revoked.has(key))throw fail(503);};
    try{
      current();
      const prepared=await read(url.searchParams.get('entryId')!,url.searchParams.get('url')!,url.pathname.endsWith('/lookup')?'lookup':'load',controller.signal);
      current();const image=prepared.image;
      if(image&&(!Buffer.isBuffer(image.data)||!(image.data.buffer instanceof ArrayBuffer)||image.data.length<1||image.data.length>MAX||!/^image\/(?:png|jpeg|webp|gif|avif)$/.test(image.mime)))throw fail(502);
      // Never serialize a pooled Buffer's backing store across the IPC boundary.
      const imageBytes=image?new Uint8Array(image.data):null;
      try{assertRecipient();}catch{throw fail(403);}
      // Recheck the original article/source grant immediately before IPC publication.
      prepared.authorize();current();
      return image?{imageBytes:imageBytes!,mime:image.mime}:{imageBytes:null};
    }catch(error){
      const status=(error as {statusCode?:number})?.statusCode;
      throw fail(controller.signal.aborted?503:status&&[401,403,404,409,423,429,503].includes(status)?status:502);
    }finally{
      clearTimeout(timer);request.signal?.removeEventListener('abort',abort);this.byteReads.delete(controller);resource.delete(controller);
      if(!resource.size&&this.resources.get(key)===resource)this.resources.delete(key);
    }
  }
  async handle(request:ImageRequest):Promise<Response>{
    const url=this.parse(request);if(!url)return denied(403);
    const key=this.resourceKey(request.url);
    const endpoint=this.endpoint,epoch=this.epoch;if(!endpoint||this.revoked.has(key))return denied(503);if(this.active.size+this.byteReads.size>=16)return denied(429);
    if(request.signal?.aborted)return denied(503);
    const controller=new AbortController();this.active.add(controller);
    const resource=this.resources.get(key)||new Set<AbortController>();resource.add(controller);this.resources.set(key,resource);
    let abortBody:(()=>void)|undefined;
    const clientAbort=()=>controller.abort();
    const cleanup=()=>{clearTimeout(timer);this.active.delete(controller);resource.delete(controller);if(!resource.size&&this.resources.get(key)===resource)this.resources.delete(key);controller.signal.removeEventListener('abort',aborted);request.signal?.removeEventListener('abort',clientAbort);};
    const aborted=()=>{abortBody?.();cleanup();};
    controller.signal.addEventListener('abort',aborted,{once:true});request.signal?.addEventListener('abort',clientAbort,{once:true});
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);timer.unref();
    const current=()=>!controller.signal.aborted&&this.epoch===epoch&&this.endpoint===endpoint;
    try{
      const target=new URL('/api/image-cache'+url.pathname,endpoint.baseUrl);target.search=new URLSearchParams({entryId:url.searchParams.get('entryId')!,url:url.searchParams.get('url')!,transport:'binary'}).toString();
      const response=await this.fetchImage(target.href,{method:'GET',headers:{'X-Rivu-Token':endpoint.token,Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif'},credentials:'omit',redirect:'manual',signal:controller.signal});
      if(!current()){await response.body?.cancel();cleanup();return denied(503);}
      if(response.status===204){await response.body?.cancel();cleanup();return denied(204);}
      const mime=(response.headers.get('content-type')||'').split(';')[0],length=response.headers.get('content-length')||'';
      if(response.status!==200||!/^image\/(?:png|jpeg|webp|gif|avif)$/.test(mime)||!/^\d+$/.test(length)||Number(length)<1||Number(length)>MAX||!response.body){
        await response.body?.cancel();cleanup();return denied([401,403,404,409,423,429,503].includes(response.status)?response.status:502);
      }
      const reader=response.body.getReader();let bytes=0;
      abortBody=()=>{void reader.cancel().catch(()=>{});};
      const body=new ReadableStream<Uint8Array>({
        async pull(output){
          try{
            if(!current())throw Error('图片请求已失效');const next=await reader.read();if(!current())throw Error('图片请求已失效');
            if(next.done){if(bytes!==Number(length))throw Error('图片响应长度无效');cleanup();output.close();return;}
            bytes+=next.value.byteLength;if(bytes>MAX||bytes>Number(length))throw Error('图片响应超过大小限制');output.enqueue(next.value);
          }catch{controller.abort();cleanup();void reader.cancel().catch(()=>{});output.error(Error('图片响应已中止'));}
        },
        cancel(){controller.abort();cleanup();return reader.cancel().catch(()=>{});}
      });
      return new Response(body,{status:200,headers:{...headers,'Content-Type':mime,'Content-Length':length}});
    }catch{controller.abort();cleanup();return denied(503);}
  }
}
