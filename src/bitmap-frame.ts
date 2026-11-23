// Candidate renderer, intentionally not wired into the reader until parity gates pass.
// Unsupported/animated inputs remain native-image candidates; never flatten them.
const MAX_BYTES=8*1024*1024,MAX_PIXELS=4*1024*1024,FRAME_BUDGET=64*1024*1024,MAX_DECODERS=2;
type Envelope={bytes:Uint8Array<ArrayBuffer>;mime:string;released?:Promise<void>};
type Policy={kind:'static';width:number;height:number}|{kind:'fallback';reason:string};
export type BitmapFrame={kind:'ready';width:number;height:number;release:()=>void}|{kind:'fallback';reason:string};
const fallback=(reason:string):Policy=>({kind:'fallback',reason});
const dimensions=(width:number,height:number):Policy=>width>0&&height>0&&Number.isSafeInteger(width*height)&&width*height<=MAX_PIXELS?{kind:'static',width,height}:fallback('dimensions');

export function inspectBitmapFrame({bytes,mime}:Envelope):Policy{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>MAX_BYTES)return fallback('bytes');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=(from:number,to:number)=>String.fromCharCode(...bytes.subarray(from,to));
 if(mime==='image/png'){
  if(bytes.length<45||text(1,4)!=='PNG'||bytes[0]!==137||bytes[4]!==13||bytes[5]!==10||bytes[6]!==26||bytes[7]!==10)return fallback('format');
  let width=0,height=0,idat=false,ended=false,header=false,chunks=0;
  for(let offset=8;offset+12<=bytes.length;){
   if(++chunks>4096)return fallback('metadata-limit');
   const length=view.getUint32(offset),end=offset+12+length;
   if(end>bytes.length)return fallback('format');
   const type=text(offset+4,offset+8);
   if(type==='IHDR'){
    if(header||offset!==8||length!==13)return fallback('format');header=true;
    width=view.getUint32(offset+8);height=view.getUint32(offset+12);
    if(bytes[offset+16]!==8||![0,2,3,4,6].includes(bytes[offset+17])||bytes[offset+18]!==0||bytes[offset+19]!==0||bytes[offset+20]>1)return fallback('format');
   }else if(!header)return fallback('format');
   if(['acTL','fcTL','fdAT'].includes(type))return fallback('animation');
   if(['iCCP','cICP','mDCv','cLLi'].includes(type))return fallback('color-profile');
   if(type==='IDAT')idat=true;
   if(type==='IEND'){if(length!==0)return fallback('format');ended=true;break;}
   if(!['IHDR','IDAT','IEND','PLTE'].includes(type)&&type[0]===type[0]?.toUpperCase())return fallback('format');
   offset=end;
  }
  return header&&idat&&ended?dimensions(width,height):fallback('format');
 }
 if(mime==='image/jpeg'){
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)return fallback('format');
  let offset=2,width=0,height=0,frame=false,segments=0;
  while(offset<bytes.length){
   if(++segments>4096)return fallback('metadata-limit');
   if(bytes[offset++]!==255)return fallback('format');
   while(offset<bytes.length&&bytes[offset]===255)offset++;
   const marker=bytes[offset++];
   if(marker===218)return frame?dimensions(width,height):fallback('format');
   if(marker===217||marker===0||marker===216||marker===1||marker>=208&&marker<=215)return fallback('format');
   if(offset+2>bytes.length)return fallback('format');
   const length=view.getUint16(offset),end=offset+length;
   if(length<2||end>bytes.length)return fallback('format');
   if(marker===225||marker===226)return fallback('metadata'); // Exif orientation / ICC / MPO require native parity.
   if([192,193,194].includes(marker)){
    if(frame||length<8||bytes[offset+2]!==8)return fallback('format');
    height=view.getUint16(offset+3);width=view.getUint16(offset+5);frame=true;
   }else if(marker>=192&&marker<=207&&![196,200,204].includes(marker))return fallback('format');
   offset=end;
  }
  return fallback('format');
 }
 return fallback('format'); // GIF, WebP and AVIF may animate; preserve native behavior.
}

type Owner={abort:()=>void};
const owners=new WeakMap<HTMLCanvasElement,Owner>();
let reservedBytes=0,decoders=0,inflight=0;
export function bitmapFrameUsage(){return {reservedBytes,decoders,inflight,maxBytes:FRAME_BUDGET,maxDecoders:MAX_DECODERS,maxInflight:MAX_DECODERS};}

export async function renderBitmapFrame(canvas:HTMLCanvasElement,read:(signal:AbortSignal)=>Promise<Envelope>,signal:AbortSignal):Promise<BitmapFrame>{
 owners.get(canvas)?.abort();
 const controller=new AbortController();let installed=false,reservation=0,decoding=false,holdingDecoded=false,settled=false,admitted=false,releaseComplete=false;
 let releaseTask:Promise<boolean>|undefined;
 const clear=()=>{if(owners.get(canvas)===owner){if(installed){canvas.width=0;canvas.height=0;installed=false;}owners.delete(canvas);}};
 const free=()=>{if(reservation){reservedBytes-=reservation;reservation=0;}};
 const abort=()=>{controller.abort();clear();if(!decoding&&!holdingDecoded)free();signal.removeEventListener('abort',abort);};
 const owner={abort};owners.set(canvas,owner);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const check=()=>{controller.signal.throwIfAborted();if(owners.get(canvas)!==owner)throw new DOMException('Bitmap superseded','AbortError');};
 let bitmap:ImageBitmap|undefined;
 try{
  check();
  // Admit before invoking the provider: each provider must enforce the8MiB cap.
  // Cancelled, non-abortable provider/decoder work retains admission until settled.
  if(inflight>=MAX_DECODERS)return {kind:'fallback',reason:'busy'};
  inflight++;admitted=true;
  const envelope=await read(controller.signal);
  if(envelope.released)releaseTask=Promise.resolve(envelope.released).then(()=>true,()=>false);
  check();
  const policy=inspectBitmapFrame(envelope);if(policy.kind==='fallback')return policy;
  if(decoders>=MAX_DECODERS)return {kind:'fallback',reason:'busy'};
  const size=policy.width*policy.height*4;
  if(reservedBytes+size>FRAME_BUDGET)return {kind:'fallback',reason:'budget'};
  reservedBytes+=size;reservation=size;decoders++;decoding=true;
  try{bitmap=await createImageBitmap(new Blob([envelope.bytes],{type:envelope.mime}));holdingDecoded=true;}
  catch(error){check();return {kind:'fallback',reason:'decode'};}
  finally{decoders--;decoding=false;}
  check();
  if(bitmap.width!==policy.width||bitmap.height!==policy.height)return {kind:'fallback',reason:'dimensions'};
  // Decode can overlap capability revocation; publication must wait for its ack.
  if(releaseTask){const released=await releaseTask;releaseComplete=true;check();if(!released)return {kind:'fallback',reason:'release'};}
  try{
   const context=canvas.getContext('bitmaprenderer');if(!context)return {kind:'fallback',reason:'context'};
   installed=true;canvas.width=policy.width;canvas.height=policy.height;context.transferFromImageBitmap(bitmap);
  }catch{return {kind:'fallback',reason:'context'};}
  check();settled=true;return {kind:'ready',width:policy.width,height:policy.height,release:abort};
 }finally{
  if(releaseTask&&!releaseComplete)await releaseTask;
  bitmap?.close();holdingDecoded=false;
  if(admitted)inflight--;
  if(!settled||controller.signal.aborted){clear();free();signal.removeEventListener('abort',abort);}
  controller.signal.throwIfAborted();
 }
}
