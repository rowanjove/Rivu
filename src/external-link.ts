import {externalUrl,INVALID_EXTERNAL_LINK,EXTERNAL_OPEN_ERROR} from '../shared/external-url';
export {externalUrl} from '../shared/external-url';

export async function openExternalLink(value:unknown,onError:(message:string)=>void,open:(url:string)=>Promise<void>=url=>window.rivu.openExternal(url)):Promise<boolean> {
  const url=externalUrl(value);
  if(!url){onError(INVALID_EXTERNAL_LINK);return false;}
  try{await open(url);return true;}
  catch{onError(EXTERNAL_OPEN_ERROR);return false;}
}
