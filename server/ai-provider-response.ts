export type AIProviderKind='models'|'completion';
export type AIProviderReply={model?:string;content?:string};
export const AI_RESPONSE_BYTES=8*1024*1024;
export const AI_MODELS_BYTES=2*1024*1024;
export const AI_CONTENT_CHARS=1024*1024;
const BUFFER_BUDGET=64*1024*1024;
let buffered=0;
const invalid=(message:string,statusCode=502)=>Object.assign(Error(message),{statusCode});

export async function readAIResponse(response:Response,maxBytes:number,truncate=false):Promise<string>{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>AI_RESPONSE_BYTES)throw invalid('AI 响应大小预算无效');
  const declared=response.headers.get('content-length');
  if(!truncate&&declared&&Number(declared)>maxBytes){void response.body?.cancel().catch(()=>{});throw invalid('AI 服务响应超过大小限制，已停止接收');}
  if(!response.body)return '';
  if(buffered+maxBytes>BUFFER_BUDGET){void response.body.cancel().catch(()=>{});throw Object.assign(invalid('AI 响应接收繁忙，请稍后重试',503),{resourceBusy:true});}
  buffered+=maxBytes;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const bytes=Buffer.allocUnsafe(maxBytes);reader=response.body.getReader();let retained=0;
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array))throw invalid('AI 服务响应字节流无效');
      if(!truncate&&retained+value.byteLength>maxBytes)throw invalid('AI 服务响应超过大小限制，已停止接收');
      const chunk=truncate?value.subarray(0,maxBytes-retained):value;
      bytes.set(chunk,retained);retained+=chunk.byteLength;
      if(truncate&&retained>=maxBytes){void reader.cancel().catch(()=>{});break;}
    }
    try{return new TextDecoder('utf-8',{fatal:!truncate}).decode(bytes.subarray(0,retained));}
    catch{throw invalid('AI 服务响应 UTF-8 编码无效');}
  }catch(error){void (reader?reader.cancel():response.body.cancel()).catch(()=>{});throw error;}
  finally{buffered-=maxBytes;reader?.releaseLock();}
}

export function decodeAIProviderResponse(text:string,kind:AIProviderKind):AIProviderReply{
  if(kind!=='models'&&kind!=='completion')throw invalid('AI 响应类型无效');
  let value:unknown;try{value=JSON.parse(text);}catch{throw invalid('AI 服务返回的 JSON 无效');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid('AI 服务响应结构无效');
  const data=value as {data?:{id?:unknown}[];choices?:{message?:{content?:unknown}}[]};
  if(kind==='models'){
    const model=Array.isArray(data.data)?data.data[0]?.id:undefined;
    if(model!==undefined&&(typeof model!=='string'||model.length>200))throw invalid('AI 服务模型名称无效');
    return {model:typeof model==='string'?model:''};
  }
  const content=Array.isArray(data.choices)?data.choices[0]?.message?.content:undefined;
  if(typeof content!=='string'||!content.trim())throw invalid('AI 返回空内容或内容格式无效');
  if(content.length>AI_CONTENT_CHARS)throw invalid('AI 返回内容超过大小限制，未保存结果');
  return {content:content.trim()};
}
