import {parentPort,workerData} from 'node:worker_threads';

// The parent fetches with its current network policy. This worker only processes bytes.
if(workerData.persistentImages){
  const {parseImageUrls}=require(workerData.imageModulePath);
  parentPort?.on('message',async ({response,candidate})=>{try{parentPort?.postMessage({result:await parseImageUrls(response,candidate)});}catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number})?.statusCode});}});
}else if(workerData.persistentAI){
  const {parseAIText,hashAIText,parseAIContext,parseAIProviderResponse}=require(workerData.modulePath);
  parentPort?.on('message',async response=>{try{parentPort?.postMessage({result:await (response.aiProviderKind?parseAIProviderResponse:response.aiHashOnly?hashAIText:response.aiContext?parseAIContext:parseAIText)(response)});}catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number})?.statusCode});}});
}else void (async()=>{try{
  if(workerData.kind==='image_urls'&&workerData.imageModulePath){const {parseImageUrls}=require(workerData.imageModulePath);parentPort?.postMessage({result:await parseImageUrls(workerData.response,workerData.candidate)});return;}
  // Load through app.asar so external dependencies resolve from its node_modules.
  const {parseFeedResponse,parseCustomJsonResponse,parseFeedPage,parseFullTextResponse,parseImageUrls,parseNewsletterBatch,parseAIText,parseArchiveImages}=require(workerData.modulePath);
  if(workerData.kind==='archive_images'){parentPort?.postMessage({result:await parseArchiveImages(workerData.response)});return;}
  if(workerData.kind==='ai_text'){parentPort?.postMessage({result:await parseAIText(workerData.response)});return;}
  if(workerData.kind==='newsletter'){parentPort?.postMessage({result:await parseNewsletterBatch(workerData.response.messages)});return;}
  const parse=workerData.kind==='custom_json'?parseCustomJsonResponse:workerData.kind==='page'?parseFeedPage:workerData.kind==='full_text'?parseFullTextResponse:workerData.kind==='image_urls'?parseImageUrls:parseFeedResponse;
  parentPort?.postMessage({result:await parse(workerData.response,workerData.candidate)});
}catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number})?.statusCode});}})();
