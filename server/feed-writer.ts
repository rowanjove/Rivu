import {Worker} from 'node:worker_threads';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {FeedWriteInput,FullTextWriteInput,EntryStateWriteInput,EntryStateWriteResult} from './feed-write-task';
import type {ArchiveWriteInput,ArchiveWriteResult} from './archive-write';
import {validBulkReadWriteResult,type BulkReadWriteInput,type BulkReadWriteResult} from './bulk-read-write';
import {validFeedCategoryWriteResult,type FeedCategoryWriteInput,type FeedCategoryWriteResult} from './feed-category-write';
import {validFeedDeleteWriteResult,validFeedDeleteReceiptResult,type FeedDeleteWriteInput,type FeedDeleteWriteResult,type FeedDeleteReceiptInput,type FeedDeleteReceiptResult} from './feed-delete-write';
import {validFeedMetadataWriteResult,validFeedMetadataReceiptResult,type FeedMetadataWriteInput,type FeedMetadataWriteResult,type FeedMetadataReceiptInput,type FeedMetadataReceiptResult} from './feed-metadata-write';
type Result={added:number;total:number;json?:ArrayBuffer};
type Input=FeedWriteInput|FullTextWriteInput|ArchiveWriteInput|EntryStateWriteInput|BulkReadWriteInput|FeedCategoryWriteInput|FeedMetadataWriteInput|FeedMetadataReceiptInput|FeedDeleteWriteInput|FeedDeleteReceiptInput;

// The service must coordinate its other writers before invoking this queue.
export class FeedWriter{
  private tail:Promise<unknown>=Promise.resolve();
  private closed=false;
  private worker:Worker|null=null;
  constructor(private workerPath:string,private modulePath=join(dirname(workerPath),'feed-write-task.cjs')){}
  write(input:FeedWriteInput):Promise<Result>{
    return this.submit(input);
  }
  writeFullText(input:FullTextWriteInput):Promise<Result>{return this.submit(input);}
  writeEntryState(input:EntryStateWriteInput):Promise<EntryStateWriteResult>{return this.submit(input) as Promise<EntryStateWriteResult>;}
  writeBulkRead(input:BulkReadWriteInput):Promise<BulkReadWriteResult>{return this.submit(input) as Promise<BulkReadWriteResult>;}
  writeArchive(input:ArchiveWriteInput):Promise<ArchiveWriteResult>{return this.submit(input) as Promise<ArchiveWriteResult>;}
  writeFeedCategory(input:FeedCategoryWriteInput):Promise<FeedCategoryWriteResult>{return this.submit(input) as Promise<FeedCategoryWriteResult>;}
  writeFeedDelete(input:FeedDeleteWriteInput):Promise<FeedDeleteWriteResult>{return this.submit(input) as Promise<FeedDeleteWriteResult>;}
  readFeedDeleteReceipt(input:FeedDeleteReceiptInput):Promise<FeedDeleteReceiptResult>{return this.submit(input) as Promise<FeedDeleteReceiptResult>;}
  writeFeedMetadata(input:FeedMetadataWriteInput):Promise<FeedMetadataWriteResult>{return this.submit(input) as Promise<FeedMetadataWriteResult>;}
  readFeedMetadataReceipt(input:FeedMetadataReceiptInput):Promise<FeedMetadataReceiptResult>{return this.submit(input) as Promise<FeedMetadataReceiptResult>;}
  private submit(input:Input):Promise<Result>{
    if(this.closed)return Promise.reject(Error('来源写入器已关闭'));
    const job=this.tail.then(()=>this.execute({...input,operationId:randomUUID()}));
    this.tail=job.catch(()=>{});return job;
  }
  private execute(input:Input):Promise<Result>{
    return new Promise((resolve,reject)=>{
      let worker:Worker;try{
        if(!this.worker){
          const created=new Worker(this.workerPath,{workerData:{modulePath:this.modulePath},resourceLimits:{maxOldGenerationSizeMb:256}});
          this.worker=created;
          created.on('error',()=>{if(this.worker===created)this.worker=null;});
          created.on('exit',()=>{if(this.worker===created)this.worker=null;});
        }
        worker=this.worker;
      }catch(error){reject(error);return;}
      let settled=false;
      const finish=(error?:unknown,result?:Result,discard=false)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);
        if(discard){if(this.worker===worker)this.worker=null;const failure=Object.assign(error instanceof Error?error:Error(String(error)),{operationId:input.operationId,outcomeUnknown:true});void worker.terminate().then(()=>reject(failure),cause=>{failure.cause=cause;reject(failure);});}
        else if(error)reject(error);else resolve(result!);
      };
      const bulk='kind' in input&&input.kind.startsWith('bulk_read');
      const category='kind' in input&&input.kind==='feed_category';
      const metadata='kind' in input&&(input.kind==='feed_patch'||input.kind==='category_delete');
      const receipt='kind' in input&&input.kind==='feed_metadata_receipt';
      const deletion='kind' in input&&input.kind==='feed_delete';
      const deletionReceipt='kind' in input&&input.kind==='feed_delete_receipt';
      const timer=setTimeout(()=>finish(Error('来源写入超时，结果待核验'),undefined,true),bulk||category||metadata||deletion?900_000:120_000);timer.unref();
      const onMessage=(message:{error?:string;statusCode?:number;result?:Result})=>{
        if(message?.error)finish(Object.assign(Error(message.error),{statusCode:message.statusCode}));
        else if(message?.result&&Number.isInteger(message.result.added)&&Number.isInteger(message.result.total)&&message.result.added>=0&&message.result.total>=message.result.added&&(!('kind' in input)||!input.kind.startsWith('archive_')||validArchiveWriteResult(message.result))&&(!('kind' in input)||input.kind!=='entry_state'||validEntryStateWriteResult(message.result))&&(!bulk||validBulkReadWriteResult(message.result))&&(!category||validFeedCategoryWriteResult(message.result,input.change.ids.length))&&(!metadata||validFeedMetadataWriteResult(message.result,input.kind))&&(!receipt||validFeedMetadataReceiptResult(message.result,input.targetKind))&&(!deletion||validFeedDeleteWriteResult(message.result,input.change.ids.length))&&(!deletionReceipt||validFeedDeleteReceiptResult(message.result,input.change.ids.length)))finish(undefined,message.result);
        else finish(Error('来源写入结果无效，结果待核验'),undefined,true);
      };
      const onError=(error:Error)=>finish(error,undefined,true);
      const onExit=(code:number)=>finish(Error(`来源写入进程退出（${code}），结果待核验`),undefined,true);
      worker.on('message',onMessage);worker.on('error',onError);worker.on('exit',onExit);
      try{worker.postMessage(input);}catch(error){finish(error,undefined,true);}
    });
  }
  async stop(){this.closed=true;await this.tail;const worker=this.worker;this.worker=null;await worker?.terminate();}
}
export function validArchiveWriteResult(value:unknown):value is ArchiveWriteResult{const result=value as ArchiveWriteResult|undefined;return !!result&&[0,1].includes(result.added)&&result.total===1&&typeof result.archiveId==='string'&&!!result.archiveId&&typeof result.versionId==='string'&&!!result.versionId&&typeof result.newVersion==='boolean';}

export function validEntryStateWriteResult(value:unknown):value is EntryStateWriteResult{const result=value as Result|undefined;return !!result&&result.added===0&&(result.total===0&&result.json===undefined||result.total===1&&result.json instanceof ArrayBuffer);}
