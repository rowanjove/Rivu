import {parentPort,workerData} from 'node:worker_threads';
const {scanAIRule,readAIBodies}=require(workerData.modulePath);
parentPort!.on('message',input=>{try{
  if(input.operation==='bodies'){
    const result=readAIBodies(input),transfer:ArrayBuffer[]=[];
    const rows=result.rows.map(({html,...row}:{html:string})=>{const buffer=Buffer.from(html,'utf16le'),htmlBuffer=new ArrayBuffer(buffer.length);new Uint8Array(htmlBuffer).set(buffer);transfer.push(htmlBuffer);return {...row,htmlBuffer};});
    parentPort!.postMessage({result:{...result,rows,transport:'utf16le'}},transfer);
  }else parentPort!.postMessage({result:scanAIRule(input)});
}catch(error){const failure=error as Error&{statusCode?:number;resourceBusy?:boolean};parentPort!.postMessage({error:failure.message,statusCode:failure.statusCode,resourceBusy:failure.resourceBusy});}});
