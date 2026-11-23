type Image={data:Buffer;mime:string};
type Binding={baseUrl:string;token:string;read:(entryId:string,url:string,mode:'lookup'|'load',signal?:AbortSignal)=>Promise<{image:Image|null;authorize:()=>void}>};

export function createDirectImageFetch({baseUrl,token,read}:Binding){
 const base=new URL(baseUrl);
 if(base.origin!==baseUrl||base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password||!token)throw Error('本地图片服务地址无效');
 return async(raw:string,options:RequestInit):Promise<Response>=>{
  const url=new URL(raw),keys=[...url.searchParams.keys()];
  if(options.method!=='GET'||url.origin!==baseUrl||url.username||url.password||url.hash||!/^\/api\/image-cache\/(lookup|load)$/.test(url.pathname)||keys.length!==3||new Set(keys).size!==3||keys.some(key=>!['entryId','url','transport'].includes(key))||url.searchParams.get('transport')!=='binary'||new Headers(options.headers).get('X-Rivu-Token')!==token)throw Error('图片内部请求无效');
  const signal=options.signal??undefined;
  try{
   signal?.throwIfAborted();
   const prepared=await read(url.searchParams.get('entryId')!,url.searchParams.get('url')!,url.pathname.endsWith('/lookup')?'lookup':'load',signal);
   signal?.throwIfAborted();const image=prepared.image;if(!image){prepared.authorize();return new Response(null,{status:204});}
   if(!Buffer.isBuffer(image.data)||image.data.length<1||image.data.length>8*1024*1024||!/^image\/(?:png|jpeg|webp|gif|avif)$/.test(image.mime))return new Response(null,{status:502});
   const backing=image.data.buffer;if(!(backing instanceof ArrayBuffer))return new Response(null,{status:502});
   prepared.authorize();
   return new Response(new Uint8Array(backing,image.data.byteOffset,image.data.byteLength),{headers:{'Content-Type':image.mime,'Content-Length':String(image.data.byteLength),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch(error){const status=(error as {statusCode?:number})?.statusCode;return new Response(null,{status:signal?.aborted?503:status&&[401,403,404,409,423,429,503].includes(status)?status:502});}
 };
}
