export const isEntryRead=(method:string,path:string)=>method==='GET'&&/^\/api\/entries\/[^/?]+(?:\?.*)?$/.test(path);
export const isImageRead=(method:string,path:string)=>method==='GET'&&/^\/api\/image-cache\/(?:lookup|load)(?:\?.*)?$/.test(path);
export function decodeImageTransport(value:unknown){
  if(!value||typeof value!=='object'||!('imageJson' in value)||typeof value.imageJson!=='string')throw Error('图片传输结果无效');
  const row:unknown=JSON.parse(value.imageJson);
  if(row===null)return null;
  if(!row||typeof row!=='object'||Array.isArray(row)||!('dataUrl' in row)||typeof row.dataUrl!=='string'||!/^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(row.dataUrl)||!('bytes' in row)||!Number.isSafeInteger(row.bytes)||Number(row.bytes)<0)throw Error('图片传输结果无效');
  return row;
}
export const isBulkReadWrite=(method:string,path:string)=>method==='POST'&&/^\/api\/entries\/mark-read(?:\/undo)?(?:\?.*)?$/.test(path);
export const isFeedCategoryWrite=(method:string,path:string,body:unknown)=>method==='POST'&&/^\/api\/feeds\/bulk(?:\?.*)?$/.test(path)&&!!body&&typeof body==='object'&&!Array.isArray(body)&&'action' in body&&body.action==='category';
export const isFeedPatch=(method:string,path:string)=>method==='PATCH'&&/^\/api\/feeds\/[^/?]+(?:\?.*)?$/.test(path);
export const isCategoryDelete=(method:string,path:string)=>method==='DELETE'&&/^\/api\/categories\/[^/?]+(?:\?.*)?$/.test(path);
export const isEntryResult=(method:string,path:string)=>(method==='GET'||method==='PATCH')&&/^\/api\/entries\/[^/?]+(?:\?.*)?$/.test(path);
export function decodeEntryTransport(value:unknown){
  if(!value||typeof value!=='object'||!('entryJson' in value)||typeof value.entryJson!=='string')throw Error('文章传输结果无效');
  const row:unknown=JSON.parse(value.entryJson);
  if(!row||typeof row!=='object'||Array.isArray(row)||!('id' in row)||typeof row.id!=='string')throw Error('文章传输结果无效');
  return row;
}
export function decodeFeedTransport(value:unknown){
  if(!value||typeof value!=='object'||!('feedJson' in value)||typeof value.feedJson!=='string')throw Error('订阅传输结果无效');
  const row:unknown=JSON.parse(value.feedJson);
  if(!row||typeof row!=='object'||Array.isArray(row)||!('id' in row)||typeof row.id!=='string')throw Error('订阅传输结果无效');
  return row;
}
