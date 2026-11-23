import {dirname,join} from 'node:path';
import type {EntryReadInput} from './entry-read-task';
import {SnapshotReader} from './snapshot-reader';

export class EntryReader extends SnapshotReader<EntryReadInput>{
  constructor(workerPath:string,modulePath=join(dirname(workerPath),'entry-read-task.cjs'),maxPending=16,timeoutMs=120000,pageCacheKiB=2048){super(workerPath,modulePath,maxPending,timeoutMs,'文章读取',undefined,{kind:'close_entry_reader'},{pageCacheKiB});}
}
