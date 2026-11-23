import { useEffect, useRef, useState } from 'react';
import { api } from './api';

type ProxyPreferences={mode:'environment'|'direct'|'custom';httpProxy:string;httpsProxy:string;noProxy:string};
const initial:ProxyPreferences={mode:'environment',httpProxy:'',httpsProxy:'',noProxy:''};

export function ProxySettings(){
  const [saved,setSaved]=useState<ProxyPreferences>(initial),[draft,setDraft]=useState<ProxyPreferences>(initial);
  const [testUrl,setTestUrl]=useState('https://github.com/RSSNext/Folo/releases.atom');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [loaded,setLoaded]=useState(false);
  const operation=useRef(false),generation=useRef(0);
  const failedDraft=useRef<Partial<ProxyPreferences>|null>(null);
  const reload=async()=>{
    if(operation.current)return;
    operation.current=true;const version=++generation.current;setBusy(true);setLoaded(false);setError('');setMessage('');
    try{const value=await api.get<ProxyPreferences>('/api/network/proxy');if(version===generation.current){setSaved(value);setDraft(failedDraft.current?{...value,...failedDraft.current}:value);failedDraft.current=null;setLoaded(true);}}
    catch(cause){if(version===generation.current)setError(`代理配置读取失败，请重试后再操作：${String(cause)}`);}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  useEffect(()=>{void reload();return()=>{generation.current++;operation.current=false;};},[]);
  const save=async()=>{
    if(!loaded||operation.current)return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');setMessage('');
    const patch:Partial<ProxyPreferences>={};for(const key of Object.keys(initial) as (keyof ProxyPreferences)[])if(draft[key]!==saved[key])Object.assign(patch,{[key]:draft[key]});
    try{const value=await api.patch<ProxyPreferences>('/api/network/proxy',patch);if(version===generation.current){setSaved(value);setDraft(value);setMessage('代理设置已保存，后续公开内容请求立即生效。');}}
    catch(cause){if(version===generation.current){failedDraft.current={...patch};setLoaded(false);setError(`保存结果未确认，草稿已保留，请重新加载代理配置：${String(cause)}`);}}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  const test=async()=>{
    if(!loaded||operation.current||JSON.stringify(saved)!==JSON.stringify(draft)||!testUrl.trim())return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');setMessage('');
    try{const result=await api.post<{url:string;bytes:number;type:string}>('/api/network/proxy/test',{url:testUrl.trim()});if(version===generation.current)setMessage(`连接成功：${result.url} · ${result.bytes} 字节 · ${result.type||'未声明类型'}`);}
    catch(cause){if(version===generation.current)setError(String(cause));}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  const changed=JSON.stringify(saved)!==JSON.stringify(draft);
  return <section className="proxy-settings"><h3>网络代理</h3>
    <p className="setting-help">只影响公开订阅、配图和归档资源。已授权的内网订阅、本地 API 和 AI Provider 始终直连。</p>
    {busy&&!loaded&&<p role="status">正在读取代理设置…</p>}
    {!loaded&&!busy&&<button className="secondary" onClick={()=>void reload()}>重试加载代理配置</button>}
    <label>连接方式 <select aria-label="连接方式" disabled={!loaded||busy} value={loaded?draft.mode:''} onChange={event=>setDraft({...draft,mode:event.target.value as ProxyPreferences['mode']})}>{!loaded&&<option value="" disabled>尚未加载</option>}<option value="environment">使用环境变量</option><option value="direct">始终直连</option><option value="custom">自定义代理</option></select></label>
    {draft.mode==='custom'&&<div className="proxy-settings-grid">
      <label>HTTP 代理<input disabled={!loaded||busy} value={draft.httpProxy} onChange={event=>setDraft({...draft,httpProxy:event.target.value})} placeholder="http://127.0.0.1:7897" spellCheck={false}/></label>
      <label>HTTPS 代理<input disabled={!loaded||busy} value={draft.httpsProxy} onChange={event=>setDraft({...draft,httpsProxy:event.target.value})} placeholder="http://127.0.0.1:7897" spellCheck={false}/></label>
      <label>不使用代理的域名<input disabled={!loaded||busy} value={draft.noProxy} onChange={event=>setDraft({...draft,noProxy:event.target.value})} placeholder="localhost,.example.com" spellCheck={false}/></label>
      <p className="setting-help">代理地址仅支持 HTTP/HTTPS，不能包含账号密码。留空的协议直连；域名可用逗号分隔，保存前会验证格式。</p>
    </div>}
    <div className="setting-actions"><button className="primary" disabled={!loaded||busy||!changed} onClick={save}>保存代理设置</button><button className="secondary" disabled={!loaded||busy||!changed} onClick={()=>{setDraft(saved);setError('');setMessage('已恢复为上次保存的设置。');}}>撤销修改</button></div>
    <div className="input-row"><input disabled={!loaded||busy} aria-label="代理连接测试地址" value={testUrl} onChange={event=>setTestUrl(event.target.value)} placeholder="https://example.com/feed.xml" spellCheck={false}/><button className="secondary" disabled={!loaded||busy||changed||!testUrl.trim()} onClick={test}>测试已保存的设置</button></div>
    {error&&<p className="dialog-error" role="alert">{error}</p>}{message&&<p className="setting-help" role="status">{message}</p>}
  </section>;
}
