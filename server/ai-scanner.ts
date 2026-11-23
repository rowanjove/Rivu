import {dirname,join} from 'node:path';
import {SnapshotReader} from './snapshot-reader';
import type {AIScanInput,AIScanResult,AIBodyInput,AIBodyResult} from './ai-scan-task';
async function decodeResult(raw:unknown){
  const result=raw as {transport?:string;rows?:{id:string;title:string;body_revision:string;htmlBuffer?:ArrayBuffer;html?:string}[];bytes?:number};
  if(result?.transport!=='utf16le')return raw;
  if(!Array.isArray(result.rows)||result.rows.length>20||!Number.isSafeInteger(result.bytes)||result.bytes!<0||result.bytes!>64*1024*1024)throw Error('AI 正文传输结果无效');
  let bytes=0;for(const row of result.rows){if(!row||typeof row.title!=='string'||!(row.htmlBuffer instanceof ArrayBuffer)||row.htmlBuffer.byteLength%2)throw Error('AI 正文传输结果无效');bytes+=256+2*row.title.length+row.htmlBuffer.byteLength;}if(bytes!==result.bytes)throw Error('AI 正文传输结果无效');
  for(const row of result.rows){row.html=Buffer.from(row.htmlBuffer!).toString('utf16le');delete row.htmlBuffer;await new Promise<void>(resolve=>setImmediate(resolve));}
  delete result.transport;return result;
}
export class AIScanner extends SnapshotReader<AIScanInput|AIBodyInput>{
  constructor(workerPath:string,modulePath=join(dirname(workerPath),'ai-scan-task.cjs'),maxPending=16,timeoutMs=120000){super(workerPath,modulePath,maxPending,timeoutMs,'AI 规则扫描',decodeResult);}
  override read(input:AIScanInput):Promise<AIScanResult>{return super.read(input) as Promise<AIScanResult>;}
  readBodies(input:AIBodyInput):Promise<AIBodyResult>{return super.read(input) as Promise<AIBodyResult>;}
}
