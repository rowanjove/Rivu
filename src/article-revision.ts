import {yieldBackgroundTask} from './background-task';

export async function encodeArticleSource(source:string,options:{signal?:AbortSignal;yieldTask?:()=>Promise<void>;chunkChars?:number}={}):Promise<Uint8Array<ArrayBuffer>>{
  const {signal,yieldTask=()=>yieldBackgroundTask(signal),chunkChars=32768}=options;
  if(!Number.isInteger(chunkChars)||chunkChars<2||chunkChars>65536)throw new RangeError('Invalid article encoding chunk size');
  signal?.throwIfAborted();
  const encoder=new TextEncoder();
  if(source.length<=chunkChars)return encoder.encode(source);
  const chunks:(Uint8Array|null)[]=[];let total=0;
  for(let offset=0;offset<source.length;){
    signal?.throwIfAborted();
    let end=Math.min(source.length,offset+chunkChars);
    // Keep valid UTF-16 pairs together; isolated surrogates retain TextEncoder's
    // replacement semantics, including pairs split exactly at a chunk boundary.
    if(end<source.length&&source.charCodeAt(end-1)>=0xd800&&source.charCodeAt(end-1)<=0xdbff&&source.charCodeAt(end)>=0xdc00&&source.charCodeAt(end)<=0xdfff)end--;
    const bytes=encoder.encode(source.slice(offset,end));chunks.push(bytes);total+=bytes.length;offset=end;
    await yieldTask();
  }
  signal?.throwIfAborted();
  const result=new Uint8Array(total);let offset=0;
  for(let i=0;i<chunks.length;i++){
    signal?.throwIfAborted();const chunk=chunks[i]!;result.set(chunk,offset);offset+=chunk.length;chunks[i]=null;
    await yieldTask();
  }
  signal?.throwIfAborted();return result;
}

export async function articleSourceRevision(source:string,signal?:AbortSignal):Promise<string>{
  const bytes=await encodeArticleSource(source,{signal});signal?.throwIfAborted();
  const digest=await crypto.subtle.digest('SHA-256',bytes);signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}
