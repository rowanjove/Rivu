import type {Readable} from 'node:stream';

type ImageResponse={statusCode:number;headers:Record<string,unknown>;stream:()=>Readable};
export async function readImageResponse(response:ImageResponse){
  const stream=response.stream(),success=response.statusCode>=200&&response.statusCode<300;
  const mime=String(response.headers['content-type']||'').split(';')[0];
  if(success&&response.statusCode!==204&&!/^image\/(?:png|jpeg|webp|gif|avif)$/.test(mime)){stream.destroy();throw Error('图片响应类型无效');}
  const limit=success?(response.statusCode===204?0:8*1024*1024):16*1024;
  const parts:Buffer[]=[];let size=0;
  try{
    for await(const part of stream){
      if(!(part instanceof Uint8Array))throw Error('图片响应字节无效');
      size+=part.byteLength;if(size>limit)throw Error('图片响应超过大小限制');
      parts.push(Buffer.from(part.buffer,part.byteOffset,part.byteLength));
    }
  }catch(error){stream.destroy();throw error;}
  if(!success){
    let message='HTTP '+response.statusCode;
    try{const payload:unknown=JSON.parse(Buffer.concat(parts,size).toString('utf8'));if(payload&&typeof payload==='object'&&'error' in payload&&typeof payload.error==='string')message=payload.error;}catch{}
    throw Error(message);
  }
  if(response.statusCode===204)return {imageBytes:null};
  if(!size)throw Error('图片响应为空');
  return {imageBytes:Buffer.concat(parts,size),mime};
}
