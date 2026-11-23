import {api} from './api';

// Keep the provider pending until main acknowledges completion/cancellation, so
// renderer admission cannot be recycled while a non-abortable read still runs.
export async function prepareNativeImageBytes(entryId:string,url:string,mode:'lookup'|'load',signal:AbortSignal){
 signal.throwIfAborted();
 let source='',revocation:Promise<void>|undefined,result:Awaited<ReturnType<typeof api.readImageUrl>>=null,failure:unknown,failed=false;
 const cancel=()=>{if(source&&!revocation){revocation=Promise.resolve().then(()=>api.cancelImageUrl(source));void revocation.catch(()=>{});}};
 signal.addEventListener('abort',cancel,{once:true});
 try{
  source=await api.imageUrl(entryId,url,mode);signal.throwIfAborted();
  result=await api.readImageUrl(source);signal.throwIfAborted();
 }catch(error){failed=true;failure=error;}
 finally{signal.removeEventListener('abort',cancel);cancel();}
 if(failed||signal.aborted){await revocation?.catch(()=>{});signal.throwIfAborted();throw failure;}
 return {image:result,released:revocation??Promise.resolve()};
}

// The plain byte API keeps its original strict completion boundary.
export async function readNativeImageBytes(entryId:string,url:string,mode:'lookup'|'load',signal:AbortSignal){
 const prepared=await prepareNativeImageBytes(entryId,url,mode,signal);
 await prepared.released.catch(()=>{});signal.throwIfAborted();return prepared.image;
}
