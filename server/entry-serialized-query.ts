import type {DatabaseSync} from 'node:sqlite';
import {isUtf8} from 'node:buffer';
import {queryEntry,queryEntryJsonBytes} from './entry-query';

export function hasImageHint(row:Record<string,unknown>){return !!row.cover||/<(?:img|image)[\s/>]/i.test(String(row.full_content||row.content||row.description||''));}

export function utf8ImageHint(bytes:Uint8Array,cover:unknown):boolean {
  if(cover)return true;
  // Latin-1 preserves byte offsets without decoding all UTF-8 into UTF-16.
  // Only decode the code point following a candidate ASCII tag, so JS's exact
  // Unicode whitespace semantics (including NBSP/BOM) remain unchanged.
  const buffer=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=buffer.toString('latin1'),tags=/<(?:img|image)/gi;
  let match:RegExpExecArray|null;
  while((match=tags.exec(text))){
    const end=match.index+match[0].length;if(end===buffer.length)continue;
    const next=buffer[end];
    if(next===47||next===62||/\s/.test(next<128?String.fromCharCode(next):buffer.subarray(end,end+4).toString('utf8')[0]))return true;
  }
  return false;
}

export function querySerializedEntry(db:DatabaseSync,id:string,metadata:Record<string,unknown>){
  const fallback=()=>{const row=queryEntry(db,id);return row?{json:new TextEncoder().encode(JSON.stringify(row)),imageHint:hasImageHint(row)}:undefined;};
  // Legacy REAL flag values must keep JSON.stringify's number semantics; SQLite
  // JSON may use a different decimal precision or non-finite representation.
  if(Object.values(metadata).some(value=>typeof value==='number'&&(!Number.isSafeInteger(value)||Object.is(value,-0))))return fallback();
  let row:ReturnType<typeof queryEntryJsonBytes>;
  try{row=queryEntryJsonBytes(db,id);}catch(error){
    if(error instanceof Error&&error.message.includes('JSON cannot hold BLOB values'))return fallback();
    throw error;
  }
  if(!row)return undefined;
  if(!(row.json instanceof Uint8Array)||!(row.image_body instanceof Uint8Array))throw Error('文章字节查询结果无效');
  // Preserve the existing decoder's normalization for malformed legacy TEXT.
  // Some node:sqlite versions truncate TEXT at NUL whereas SQLite JSON does
  // not. Delegate escaped NUL records to that runtime's original getter too.
  if(!isUtf8(row.json)||Buffer.from(row.json.buffer,row.json.byteOffset,row.json.byteLength).includes('\\u0000'))return fallback();
  const bytes=row.json,json=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength&&bytes.buffer instanceof ArrayBuffer?new Uint8Array(bytes.buffer):new Uint8Array(bytes);
  return {json,imageHint:utf8ImageHint(row.image_body,row.image_cover)};
}
