import { useEffect, useRef, useState } from 'react';
import { api, type SmartFolder } from './api';

type Preview={sample:{id:string;title:string;feed_title:string}[];hasMore:boolean};

export function SmartFoldersSettings({folders,initialQuery,onChanged}:{folders:SmartFolder[];initialQuery:string;onChanged:(folders:SmartFolder[])=>Promise<void>}){
  const [name,setName]=useState(''),[query,setQuery]=useState(''),[editingId,setEditingId]=useState<string|null>(null),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const operation=useRef(false),generation=useRef(0);
  const [needsReload,setNeedsReload]=useState(false);
  useEffect(()=>()=>{generation.current++;},[]);
  useEffect(()=>{if(initialQuery){setQuery(initialQuery);setName('');setEditingId(null);setPreview(null);}},[initialQuery]);
  const reload=async()=>{const version=generation.current,next=await api.get<SmartFolder[]>('/api/smart-folders');if(version===generation.current)await onChanged(next);};
  const reset=()=>{setName('');setQuery('');setEditingId(null);setPreview(null);};
  const run=async(work:()=>Promise<unknown>,changed=false)=>{
    if(operation.current||needsReload)return null;
    operation.current=true;const version=generation.current;setBusy(true);setError('');setNotice('');
    try{
      const result=await work();if(version!==generation.current)return null;
      if(changed)try{await reload();}catch(cause){if(version===generation.current){setNeedsReload(true);setError(`操作已完成，但分类列表更新失败，请重新加载智能分类：${String(cause)}`);}}
      return version===generation.current?result:null;
    }catch(cause){if(version===generation.current)setError(String(cause));return null;}
    finally{operation.current=false;if(version===generation.current)setBusy(false);}
  };
  const resync=async()=>{
    if(operation.current)return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');
    try{await reload();if(version===generation.current)setNeedsReload(false);}
    catch(cause){if(version===generation.current)setError(String(cause));}
    finally{operation.current=false;if(version===generation.current)setBusy(false);}
  };
  const showPreview=async()=>{const result=await run(()=>api.post<Preview>('/api/smart-folders/preview',{query}));if(result)setPreview(result as Preview);};
  const save=async()=>{const result=await run(()=>editingId?api.patch(`/api/smart-folders/${editingId}`,{name,query}):api.post('/api/smart-folders',{name,query}),true);if(result){setNotice(editingId?'智能分类已更新。':'智能分类已保存，侧栏会显示实时结果。');reset();}};
  const edit=(folder:SmartFolder)=>{setEditingId(folder.id);setName(folder.name);setQuery(folder.query);setPreview(null);};
  const remove=async(folder:SmartFolder)=>{if(!confirm(`删除智能分类“${folder.name}”？文章不会被删除。`))return;const result=await run(()=>api.del(`/api/smart-folders/${folder.id}`),true);if(result){if(editingId===folder.id)reset();setNotice('智能分类已删除，文章仍保存在原订阅中。');}};
  return <section className="smart-folders-settings" id="smart-folders-settings">
    <h3>智能分类</h3>
    <p className="muted">保存搜索条件，随订阅与阅读状态实时更新，不复制文章。支持关键词、feed:、tag:、is:unread、is:starred、is:saved、after:7d 等条件；unread 可简写为 is:unread，带空格的订阅名请写成 feed:"Alpha News"。空格或 AND 表示同时满足。</p>
    {needsReload&&<button className="secondary" disabled={busy} onClick={()=>void resync()}>重新加载智能分类</button>}
    <div className="smart-folder-form">
      <label>名称<input disabled={busy} value={name} maxLength={80} placeholder="例如：最近一周 AI 新闻" onChange={event=>setName(event.target.value)}/></label>
      <label>查询<input disabled={busy} value={query} maxLength={500} placeholder="AI is:unread after:7d" onChange={event=>{setQuery(event.target.value);setPreview(null);}}/></label>
    </div>
    <div className="setting-actions"><button className="secondary" disabled={busy||needsReload||!query.trim()} onClick={showPreview}>预演查询</button><button className="primary" disabled={busy||needsReload||!name.trim()||!query.trim()} onClick={save}>{editingId?'保存修改':'保存智能分类'}</button>{editingId&&<button className="secondary" disabled={busy} onClick={reset}>取消编辑</button>}</div>
    {preview&&<div className="rule-preview"><strong>预演：显示前 {preview.sample.length} 篇{preview.hasMore?'，还有更多结果':''}</strong><ul>{preview.sample.map(item=><li key={item.id}>{item.feed_title} · {item.title}</li>)}</ul></div>}
    <div className="smart-folder-list">{folders.map(folder=><div className="smart-folder-row" key={folder.id}><div><strong>{folder.name}</strong><small>{folder.query}</small></div><button className="secondary" disabled={busy||needsReload} onClick={()=>edit(folder)}>编辑</button><button className="secondary danger" disabled={busy||needsReload} onClick={()=>remove(folder)}>删除</button></div>)}</div>
    {notice&&<p className="rule-notice" role="status">{notice}</p>}{error&&<p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
