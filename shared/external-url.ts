export const INVALID_EXTERNAL_LINK='链接地址无效。';
export const EXTERNAL_OPEN_ERROR='无法打开链接，请检查默认浏览器设置或稍后重试。';

export function externalUrl(value:unknown):string|null {
  if(typeof value!=='string')return null;
  try{const url=new URL(value);return (url.protocol==='http:'||url.protocol==='https:')&&url.hostname?url.href:null;}
  catch{return null;}
}
