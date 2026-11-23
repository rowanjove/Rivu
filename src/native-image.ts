import {api} from './api';

export function loadNativeImage(image:HTMLImageElement,entryId:string,url:string,options:{cacheOnly?:boolean;onStatus?:(status:'loading'|'ready'|'error')=>void}={}){
  let cancelled=false,attempt=0,source='',timer:ReturnType<typeof setTimeout>|undefined;
  const title=image.title;
  const release=()=>{const previous=source;source='';if(previous){if(image.src===previous)image.removeAttribute('src');void api.cancelImageUrl(previous).catch(()=>{});}};
  const retry=()=>{
    if(cancelled||timer!==undefined)return;
    release();
    if(++attempt>=3){image.title='图片加载失败，可检查来源或网络授权';options.onStatus?.('error');return;}
    timer=setTimeout(()=>{timer=undefined;void start();},attempt*150);
  };
  const start=async()=>{
    if(cancelled)return;release();options.onStatus?.('loading');
    try{const next=await api.imageUrl(entryId,url,attempt===0&&options.cacheOnly?'lookup':'load');if(cancelled){void api.cancelImageUrl(next).catch(()=>{});return;}source=next;image.src=next;}catch{retry();}
  };
  const loaded=()=>{if(!cancelled&&image.currentSrc===source){image.title=title;options.onStatus?.('ready');}};
  const failed=()=>{if(!cancelled&&source&&image.src===source)retry();};
  image.addEventListener('load',loaded);image.addEventListener('error',failed);void start();
  return ()=>{if(cancelled)return;cancelled=true;release();clearTimeout(timer);image.removeEventListener('load',loaded);image.removeEventListener('error',failed);image.removeAttribute('src');image.title=title;};
}
