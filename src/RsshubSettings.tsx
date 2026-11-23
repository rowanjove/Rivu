import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { api, type RsshubInstance } from './api';

export function RsshubSettings(){
  const [instances,setInstances]=useState<RsshubInstance[]>([]),[name,setName]=useState(''),[baseUrl,setBaseUrl]=useState(''),[allowPrivate,setAllowPrivate]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false);
  const operation=useRef(false),generation=useRef(0);
  const read=async()=>{const version=generation.current,next=await api.get<RsshubInstance[]>('/api/rsshub/instances');if(version===generation.current){setInstances(next);setLoaded(true);}};
  const reload=async()=>{
    if(operation.current)return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');setLoaded(false);
    try{await read();}catch(cause){if(version===generation.current)setError(`实例列表读取失败，请重试：${String(cause)}`);}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  useEffect(()=>{void reload();return()=>{generation.current++;operation.current=false;};},[]);
  const change=async(work:()=>Promise<unknown>,added=false)=>{
    if(!loaded||operation.current)return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');setNotice('');
    try{
      await work();if(version!==generation.current)return;
      if(added){setName('');setBaseUrl('');setAllowPrivate(false);}
      setNotice(added?'实例已添加。':'实例已删除，已有订阅会保留。');
      try{await read();}catch(cause){if(version===generation.current){setLoaded(false);setError(`操作已完成，但实例列表更新失败，请重新加载：${String(cause)}`);}}
    }catch(cause){if(version===generation.current)setError(String(cause));}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  const add=()=>{if(!name.trim()||!baseUrl.trim())return;void change(()=>api.post('/api/rsshub/instances',{name:name.trim(),baseUrl:baseUrl.trim(),allowPrivate}),true);};
  return <section className="rsshub-settings"><h3>RSSHub 实例</h3>
    <p className="setting-help">添加官方、本地或自建 RSSHub 实例。订阅时填写该实例支持的路由。</p>
    {busy&&<p role="status">{loaded?'正在更新实例…':'正在读取实例列表…'}</p>}
    {!loaded&&!busy&&<button className="secondary" onClick={()=>void reload()}>重新加载 RSSHub 实例</button>}
    {instances.map(instance=><div className="hub-instance" key={instance.id}><div><strong>{instance.name}</strong><small>{instance.base_url}{instance.allow_private?' · 已允许本地网络':''}</small></div><button className="icon-button danger" title={`删除 ${instance.name}`} disabled={!loaded||busy} onClick={()=>{if(confirm(`删除实例 ${instance.name}？已有订阅会保留。`))void change(()=>api.del(`/api/rsshub/instances/${instance.id}`));}}><X size={16}/></button></div>)}
    <div className="input-row hub-add"><input aria-label="实例名称" disabled={!loaded||busy} value={name} onChange={event=>setName(event.target.value)} placeholder="实例名称"/><input aria-label="RSSHub 实例地址" disabled={!loaded||busy} value={baseUrl} onChange={event=>setBaseUrl(event.target.value)} placeholder="https://rsshub.example.com"/><button className="secondary" disabled={!loaded||busy||!name.trim()||!baseUrl.trim()} onClick={add}><Plus size={15}/>添加</button></div>
    <label className="local-network-option"><input type="checkbox" disabled={!loaded||busy} checked={allowPrivate} onChange={event=>setAllowPrivate(event.target.checked)}/>允许此实例访问 localhost 或内网 IP（仅可信实例）</label>
    {error&&<p className="dialog-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
