import {parentPort,workerData} from 'node:worker_threads';
const {writeFeedBatch,writeFullTextBatch,writeArchiveBatch,writeEntryState,writeBulkRead,writeFeedCategory,writeFeedMetadata,readFeedMetadataReceipt,writeFeedDelete,readFeedDeleteReceipt}=require(workerData.modulePath);
parentPort?.on('message',input=>{
  let result;
  try{result=input.kind==='feed_delete_receipt'?readFeedDeleteReceipt(input):input.kind==='feed_delete'?writeFeedDelete(input):input.kind==='feed_metadata_receipt'?readFeedMetadataReceipt(input):input.kind==='feed_patch'||input.kind==='category_delete'?writeFeedMetadata(input):input.kind==='feed_category'?writeFeedCategory(input):input.kind?.startsWith('bulk_read')?writeBulkRead(input):input.kind==='entry_state'?writeEntryState(input):input.kind==='archive_body'||input.kind==='archive_asset'?writeArchiveBatch(input):input.kind==='full_text'?writeFullTextBatch(input):writeFeedBatch(input);}
  catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error),statusCode:(error as {statusCode?:number})?.statusCode});return;}
  // The transaction may already be committed. A send failure must terminate the
  // Worker so its parent treats the outcome as unknown, never as a rolled-back task.
  parentPort?.postMessage({result},result.json instanceof ArrayBuffer?[result.json]:[]);
});
