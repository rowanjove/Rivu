import {dirname,join} from 'node:path';
import type {ArchiveReadInput} from './archive-read-task';
import {SnapshotReader} from './snapshot-reader';
export class ArchiveReader extends SnapshotReader<ArchiveReadInput>{
  constructor(workerPath:string,modulePath=join(dirname(workerPath),'archive-read-task.cjs'),maxPending=16,timeoutMs=120000){super(workerPath,modulePath,maxPending,timeoutMs,'归档读取');}
}
