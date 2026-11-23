const MIME=/^image\/(?:png|jpeg|webp|gif|avif)$/;
export function imageBinaryPayload(value:unknown):{bytes:Uint8Array<ArrayBuffer>;mime:string}|null{
  if(!value||typeof value!=='object'||!('imageBytes' in value))throw Error('图片传输结果无效');
  if(value.imageBytes===null)return null;
  if(!(value.imageBytes instanceof Uint8Array)||!(value.imageBytes.buffer instanceof ArrayBuffer)||value.imageBytes.byteLength===0||value.imageBytes.byteLength>8*1024*1024||!('mime' in value)||typeof value.mime!=='string'||!MIME.test(value.mime))throw Error('图片传输结果无效');
  const bytes=value.imageBytes as Uint8Array<ArrayBuffer>;
  return {bytes:bytes.byteOffset===0&&bytes.buffer.byteLength===bytes.byteLength?bytes:new Uint8Array(bytes),mime:value.mime};
}
export async function decodeImageBinaryTransport(value:unknown){
  const image=imageBinaryPayload(value);if(!image)return null;
  // Browser encoding runs in the isolated renderer, never in Electron's main
  // process. FileReader owns no persistent object URL that needs revocation.
  const dataUrl=await new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(Error('图片传输解码失败'));
    reader.onabort=()=>reject(Error('图片传输解码已取消'));
    reader.onload=()=>typeof reader.result==='string'?resolve(reader.result):reject(Error('图片传输解码失败'));
    reader.readAsDataURL(new Blob([image.bytes],{type:image.mime}));
  });
  return {dataUrl,bytes:image.bytes.byteLength};
}
