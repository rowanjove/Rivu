import { useEffect, useRef, useState } from 'react';
import { api, type Feed, type Tag } from './api';

type Conditions={feedId?:string;titleKeyword?:string;bodyKeyword?:string;after?:string;before?:string;type?:'rss'|'rsshub'|'custom_json'|'newsletter';tagId?:string};
type Action={type:'tag'|'save'|'mute'|'block';tagId?:string};
type Rule={id:string;name:string;priority:number;enabled:boolean;conditions:Conditions;action:Action};
type Preview={matching:number;pending:number;sample:{id:string;title:string;feedTitle:string}[]};
const actionName={tag:'加标签',save:'稍后阅读',mute:'静音',block:'屏蔽'};

export function RulesSettings({feeds,tags,onChanged}:{feeds:Feed[];tags:Tag[];onChanged:()=>Promise<void>}){
  const [rules,setRules]=useState<Rule[]>([]),[name,setName]=useState(''),[priority,setPriority]=useState(0),[conditions,setConditions]=useState<Conditions>({}),[action,setAction]=useState<Action>({type:'save'}),[draftPreview,setDraftPreview]=useState<Preview|null>(null),[preview,setPreview]=useState<{id:string;result:Preview}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const operation=useRef(false),generation=useRef(0);
  const [needsReload,setNeedsReload]=useState(true);
  const reload=async()=>{const version=generation.current,next=await api.get<Rule[]>('/api/rules');if(version===generation.current){setRules(next);setNeedsReload(false);}};
  useEffect(()=>{const version=generation.current;void reload().catch(cause=>{if(version===generation.current)setError(String(cause));});return()=>{generation.current++;};},[]);
  const draft=()=>({name,priority,conditions,action});
  const changeCondition=(key:keyof Conditions,value:string)=>{setDraftPreview(null);setConditions(old=>{const next={...old};if(value)Object.assign(next,{[key]:value});else delete next[key];return next;});};
  const run=async(work:()=>Promise<unknown>,changed=false,committed=false)=>{
    if(operation.current||needsReload)return null;
    operation.current=true;const version=generation.current;
    setBusy(true);setError('');setNotice('');
    try{
      const result=await work();if(version!==generation.current)return null;
      if(committed)try{await reload();if(changed)await onChanged();}catch(cause){if(version===generation.current){setNeedsReload(true);setError(`操作已完成，但规则列表更新失败，请重新加载规则：${String(cause)}`);}}
      return version===generation.current?result:null;
    }catch(cause){if(version===generation.current)setError(String(cause));return null;}
    finally{operation.current=false;if(version===generation.current)setBusy(false);}
  };
  const resync=async()=>{
    if(operation.current)return;
    operation.current=true;const version=generation.current;setBusy(true);setError('');
    try{await reload();await onChanged();}
    catch(cause){if(version===generation.current){setNeedsReload(true);setError(String(cause));}}
    finally{operation.current=false;if(version===generation.current)setBusy(false);}
  };
  const previewDraft=async()=>{const result=await run(()=>api.post<Preview>('/api/rules/preview',draft()));if(result)setDraftPreview(result as Preview);};
  const create=async()=>{const result=await run(()=>api.post('/api/rules',draft()),false,true);if(result){setName('');setDraftPreview(null);setNotice('规则已保存；点击“执行全部规则”可处理已有文章，新文章会在刷新后自动处理。');}};
  const previewExisting=async(id:string)=>{const result=await run(()=>api.get<Preview>(`/api/rules/${id}/preview`));if(result)setPreview({id,result:result as Preview});};
  const applyAll=async()=>{const result=await run(()=>api.post<{inserted:number;removed:number}>('/api/rules/apply',{}),true,true);if(result)setNotice(`规则已执行：新增 ${(result as {inserted:number}).inserted} 条效果，撤销 ${(result as {removed:number}).removed} 条失效效果。`);};
  const applyOne=async(id:string)=>{const result=await run(()=>api.post<{inserted:number;removed:number}>(`/api/rules/${id}/apply`,{}),true,true);if(result)setNotice(`这条规则已执行：新增 ${(result as {inserted:number}).inserted} 条效果，撤销 ${(result as {removed:number}).removed} 条失效效果。`);};
  const patch=async(id:string,body:unknown)=>{await run(()=>api.patch(`/api/rules/${id}`,body),true,true);setPreview(null);};
  const undo=async(id:string)=>{const result=await run(()=>api.post<{removed:number}>(`/api/rules/${id}/undo`,{}),true,true);if(result){setPreview(null);setNotice(`已停用规则并撤销 ${(result as {removed:number}).removed} 条效果。`);}};
  const remove=async(id:string)=>{if(!confirm('删除这条规则及其产生的本地效果？'))return;await run(()=>api.del(`/api/rules/${id}`),true,true);setPreview(null);};
  return <section className="rules-settings">
    <h3>本地规则</h3>
    <p className="muted">规则只处理本地文章。预演不会改动数据；标签与稍后阅读的手动设置独立保留。静音文章退出收件箱，屏蔽文章集中在“已屏蔽”。</p>
    {needsReload&&<button className="secondary" disabled={busy} onClick={()=>void resync()}>重新加载规则</button>}
    <div className="rule-form">
      <label>规则名称<input disabled={busy} value={name} maxLength={80} onChange={event=>{setName(event.target.value);setDraftPreview(null);}} placeholder="例如：收藏科研文章" /></label>
      <label>优先级<input disabled={busy} type="number" min={-1000} max={1000} value={priority} onChange={event=>{setPriority(Number(event.target.value));setDraftPreview(null);}} /></label>
      <label>订阅<select disabled={busy} value={conditions.feedId||''} onChange={event=>changeCondition('feedId',event.target.value)}><option value="">任意订阅</option>{feeds.map(feed=><option key={feed.id} value={feed.id}>{feed.title}</option>)}</select></label>
      <label>标题包含<input disabled={busy} value={conditions.titleKeyword||''} onChange={event=>changeCondition('titleKeyword',event.target.value)} placeholder="关键词" /></label>
      <label>正文包含<input disabled={busy} value={conditions.bodyKeyword||''} onChange={event=>changeCondition('bodyKeyword',event.target.value)} placeholder="关键词" /></label>
      <label>开始日期<input disabled={busy} type="date" value={conditions.after||''} onChange={event=>changeCondition('after',event.target.value)} /></label>
      <label>结束日期<input disabled={busy} type="date" value={conditions.before||''} onChange={event=>changeCondition('before',event.target.value)} /></label>
      <label>订阅类型<select disabled={busy} value={conditions.type||''} onChange={event=>changeCondition('type',event.target.value)}><option value="">任意类型</option><option value="rss">RSS/Atom/JSON Feed</option><option value="rsshub">RSSHub</option><option value="custom_json">自定义 JSON API</option><option value="newsletter">本地 Newsletter</option></select></label>
      <label>已有标签<select disabled={busy} value={conditions.tagId||''} onChange={event=>changeCondition('tagId',event.target.value)}><option value="">不限标签</option>{tags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>
      <label>动作<select disabled={busy} value={action.type} onChange={event=>{setAction({type:event.target.value as Action['type']});setDraftPreview(null);}}>{Object.entries(actionName).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {action.type==='tag'&&<label>添加标签<select disabled={busy} value={action.tagId||''} onChange={event=>{setAction({type:'tag',tagId:event.target.value||undefined});setDraftPreview(null);}}><option value="">选择标签</option>{tags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>}
    </div>
    <div className="setting-actions"><button className="secondary" disabled={busy||needsReload||!name.trim()} onClick={previewDraft}>预演条件</button><button className="primary" disabled={busy||needsReload||!name.trim()} onClick={create}>保存规则</button><button className="secondary" disabled={busy||needsReload||!rules.some(rule=>rule.enabled)} onClick={applyAll}>执行全部规则</button></div>
    {draftPreview&&<div className="rule-preview"><strong>草稿预演：匹配 {draftPreview.matching} 篇</strong><ul>{draftPreview.sample.map(item=><li key={item.id}>{item.feedTitle} · {item.title}</li>)}</ul></div>}
    <div className="rule-list">{rules.map(rule=><div className="rule-card" key={rule.id}>
      <div className="rule-card-heading"><strong>{rule.name}</strong><span>优先级 {rule.priority} · {actionName[rule.action.type]}{rule.action.tagId?`：${tags.find(tag=>tag.id===rule.action.tagId)?.name||'已删除标签'}`:''}</span></div>
      <div className="rule-card-actions"><label><input type="checkbox" checked={rule.enabled} disabled={busy||needsReload} onChange={event=>patch(rule.id,{enabled:event.target.checked})}/> 启用</label><button className="secondary" disabled={busy||needsReload} onClick={()=>previewExisting(rule.id)}>预演</button><button className="secondary" disabled={busy||needsReload||!rule.enabled} onClick={()=>applyOne(rule.id)}>执行此规则</button><button className="secondary" disabled={busy||needsReload} onClick={()=>undo(rule.id)}>撤销并停用</button><button className="secondary danger" disabled={busy||needsReload} onClick={()=>remove(rule.id)}>删除</button></div>
      {preview?.id===rule.id&&<div className="rule-preview"><strong>匹配 {preview.result.matching} 篇 · 尚未应用 {preview.result.pending} 篇</strong><ul>{preview.result.sample.map(item=><li key={item.id}>{item.feedTitle} · {item.title}</li>)}</ul></div>}
    </div>)}</div>
    {notice&&<p className="rule-notice" role="status">{notice}</p>}{error&&<p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
