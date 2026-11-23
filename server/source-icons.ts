import {createHash} from 'node:crypto';

const headers=new Set(['png','jpeg','webp','gif','avif','x-icon','vnd.microsoft.icon'].map(type=>`data:image/${type};base64`));
export function sourceIconKey(value:unknown){
  if(typeof value!=='string'||value.length>350_000)return null;
  const comma=value.indexOf(',');if(comma<0||!headers.has(value.slice(0,comma)))return null;
  const body=value.slice(comma+1),bytes=Buffer.from(body,'base64');
  if(!bytes.length||bytes.length>256*1024||bytes.toString('base64').replace(/=+$/,'')!==body.replace(/=+$/,''))return null;
  return createHash('sha256').update(value).digest('hex');
}
