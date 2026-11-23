import {useModalFocus} from './useModalFocus';
import { useRef, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, type Tag } from './api';

export function TagPicker({entryId,onClose,onChanged}:{entryId:string;onClose:()=>void;onChanged:()=>Promise<void>}){
  const dialogRef=useRef<HTMLDivElement>(null);useModalFocus(dialogRef,onClose);
  const operation=useRef(false),generation=useRef(0);
  const [tags,setTags]=useState<Tag[]>([]),[selected,setSelected]=useState<string[]>([]),[ruleTags,setRuleTags]=useState<string[]>([]),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loadedId,setLoadedId]=useState<string|null>(null);
  const loaded=loadedId===entryId;
  const assign=(assigned:Tag[])=>{setSelected(assigned.filter(tag=>tag.manual).map(tag=>tag.id));setRuleTags(assigned.filter(tag=>tag.rule_based).map(tag=>tag.id));};
  const reload=async()=>{
    if(operation.current)return;
    operation.current=true;const version=++generation.current;
    setBusy(true);setLoadedId(null);setError('');setTags([]);setSelected([]);setRuleTags([]);
    try{
      const [all,assigned]=await Promise.all([api.get<Tag[]>('/api/tags'),api.get<Tag[]>(`/api/entries/${entryId}/tags`)]);
      if(version!==generation.current)return;
      setTags(all);assign(assigned);setLoadedId(entryId);
    }catch(cause){if(version===generation.current)setError(`标签读取失败，请重试后再编辑：${String(cause)}`);}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  useEffect(()=>{void reload();return()=>{generation.current++;operation.current=false;};},[entryId]);
  const create=async()=>{
    if(!loaded||operation.current||!name.trim())return;
    operation.current=true;const version=generation.current;
    setBusy(true);setError('');
    try{
      const tag=await api.post<Tag>('/api/tags',{name:name.trim()});
      if(version!==generation.current)return;
      setTags(old=>[...old,tag]);setSelected(old=>[...old,tag.id]);setName('');
    }catch(cause){if(version===generation.current)setError(String(cause));}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  const save=async()=>{
    if(!loaded||operation.current)return;
    operation.current=true;const version=generation.current;
    setBusy(true);setError('');
    try{
      const assigned=await api.patch<Tag[]>(`/api/entries/${entryId}/tags`,{tagIds:selected});
      if(version!==generation.current)return;
      assign(assigned);
      try{await onChanged();}catch(cause){if(version===generation.current)setError(`标签已保存，但列表更新失败，请稍后重试：${String(cause)}`);return;}
      if(version===generation.current)onClose();
    }catch(cause){if(version===generation.current)setError(String(cause));}
    finally{if(version===generation.current){operation.current=false;setBusy(false);}}
  };
  return <div className="overlay" onMouseDown={event=>event.target===event.currentTarget&&onClose()}>
    <div className="dialog tag-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tag-picker-title" tabIndex={-1}>
      <div className="dialog-heading"><h2 id="tag-picker-title">文章标签</h2><button className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={18}/></button></div>
      <p>用标签整理文章。规则添加的标签可在规则设置中撤销，也可保留为手动标签。</p>
      {busy&&<p role="status">{loaded?'正在保存标签…':'正在读取标签…'}</p>}
      <div className="tag-list">{tags.map(tag=><div className="tag-choice" key={tag.id}>
        <label><input type="checkbox" checked={selected.includes(tag.id)||ruleTags.includes(tag.id)} disabled={!loaded||busy||ruleTags.includes(tag.id)} onChange={event=>setSelected(old=>event.target.checked?[...old,tag.id]:old.filter(id=>id!==tag.id))}/><span className="tag-dot" style={{background:tag.color}}/>{tag.name}{ruleTags.includes(tag.id)&&' · 规则'}</label>
        {ruleTags.includes(tag.id)&&!selected.includes(tag.id)&&<button className="secondary" disabled={!loaded||busy} onClick={()=>setSelected(old=>[...old,tag.id])}>保留为手动标签</button>}
      </div>)}</div>
      <div className="input-row"><input disabled={!loaded||busy} value={name} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();void create();}}} placeholder="新标签名称"/><button className="secondary" disabled={!loaded||busy||!name.trim()} onClick={()=>void create()}>创建</button></div>
      {error&&<p className="dialog-error" role="alert">{error}</p>}
      {!loaded&&!busy&&<button className="secondary" onClick={()=>void reload()}>重试加载标签</button>}
      <div className="dialog-actions"><button className="primary" disabled={!loaded||busy} onClick={()=>void save()}>保存标签</button></div>
    </div>
  </div>;
}
