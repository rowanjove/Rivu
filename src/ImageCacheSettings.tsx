import { useEffect, useRef, useState } from 'react';
import { api } from './api';

type CacheSettings={enabled:boolean;maxBytes:number};
type CacheStats={count:number;bytes:number;cleanupError?:string|null;needsCleanup?:boolean};
const GIB=1024**3;
export function ImageCacheSettings(){
  const [settings,setSettings]=useState<CacheSettings>({enabled:false,maxBytes:GIB}),[stats,setStats]=useState<CacheStats>({count:0,bytes:0}),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false);
  const operation=useRef(false),generation=useRef(0);
  const read=async()=>{const version=generation.current,[preferences,counts]=await Promise.all([api.get<CacheSettings>('/api/image-cache/settings'),api.get<CacheStats>('/api/image-cache/stats')]);if(version===generation.current){setSettings(preferences);setStats(counts);setLoaded(true);}};
  const load=async()=>{
    if(operation.current)return;
    operation.current=true;const version=++generation.current;setBusy(true);setLoaded(false);setError('');
    try{await read();}catch(cause){if(version===generation.current)setError(`图片缓存信息读取失败，请重试：${String(cause)}`);}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  useEffect(()=>{void load();return()=>{generation.current++;operation.current=false;};},[]);
  const save=async(patch:Partial<CacheSettings>)=>{
    if(!loaded||operation.current)return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');setNotice('');
    try{
      const preferences=await api.patch<CacheSettings>('/api/image-cache/settings',patch);if(version!==generation.current)return;
      setSettings(preferences);setNotice('图片缓存设置已保存。');window.dispatchEvent(new Event('rivu-image-cache-updated'));
      try{await read();}catch(cause){if(version===generation.current){setLoaded(false);setError(`设置已保存，但缓存信息更新失败，请重新加载：${String(cause)}`);}}
    }catch(cause){if(version===generation.current){setLoaded(false);setError(`保存结果未确认，请重新加载图片缓存信息：${String(cause)}`);}}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  return <section className="image-cache-settings"><h3>文章图片</h3>
    {busy&&<p role="status">{loaded?'正在保存图片缓存设置…':'正在读取图片缓存信息…'}</p>}
    {!loaded&&!busy&&<button className="secondary" onClick={()=>void load()}>重新加载图片缓存信息</button>}
    <label>缓存文章图片 <input type="checkbox" disabled={!loaded||busy} checked={settings.enabled} aria-checked={loaded?settings.enabled:'mixed'} ref={node=>{if(node)node.indeterminate=!loaded;}} onChange={event=>void save({enabled:event.target.checked})}/></label>
    <p className="setting-help">默认使用远程图片。开启后，阅读文章时缓存支持的图片；已缓存图片可以离线显示。</p>
    <label>最大缓存 <select aria-label="最大缓存" disabled={!loaded||busy} value={loaded?settings.maxBytes:''} onChange={event=>void save({maxBytes:Number(event.target.value)})}>{!loaded&&<option value="" disabled>尚未加载</option>}{[1,2,5,10].map(n=><option key={n} value={n*GIB}>{n} GB</option>)}<option value={0}>无限制</option></select></label>
    <p className="setting-help">{loaded?`已缓存 ${stats.count} 张 · ${(stats.bytes/1024/1024).toFixed(1)} MB`:'缓存信息尚未加载'}</p>
    {loaded&&stats.needsCleanup&&<><p role="alert">{stats.cleanupError||'缓存索引统计超过当前上限。'} 重试仅清理普通图片缓存，文章与永久归档会保留。</p><button className="secondary" disabled={busy} onClick={()=>void save({maxBytes:settings.maxBytes})}>重新执行缓存限额</button></>}
    {error&&<p className="dialog-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
