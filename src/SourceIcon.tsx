import { useEffect, useRef, useState } from 'react';
import {getSourceIcon} from './source-icon-cache';
import './source-icon.css';

export function SourceIcon({icon,iconKey,feedId,title}:{icon?:string|null;iconKey?:string|null;feedId?:string;title:string}){
  const [failed,setFailed]=useState(false);
  const [snapshot,setSnapshot]=useState<string|null>(null),[visible,setVisible]=useState(false);
  const shell=useRef<HTMLSpanElement>(null);
  useEffect(()=>{if(!shell.current)return;const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'150px'});observer.observe(shell.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    let active=true;setSnapshot(null);setFailed(false);
    if(visible&&feedId&&iconKey&&/^[a-f0-9]{64}$/.test(iconKey))void getSourceIcon(feedId,iconKey).then(value=>{if(active)setSnapshot(value);},()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[visible,feedId,iconKey,icon]);
  const image=icon||snapshot;
  const localImage=!!image&&image.length<=350_000&&/^data:image\/(?:png|jpeg|webp|gif|avif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/.test(image);
  return <span className="source-icon-shell" ref={shell}>{localImage&&!failed?<img className="source-icon" src={image!} alt={`${title} 来源图标`} onError={()=>setFailed(true)}/>:<span className="source-icon source-icon-fallback" aria-hidden="true">{title.trim().slice(0,1)||'·'}</span>}</span>;
}
