import { useEffect, useState } from 'react';
import { api, type Feed, type Tag } from './api';

type Conditions={feedId?:string;titleKeyword?:string;bodyKeyword?:string;after?:string;before?:string;type?:'rss'|'rsshub'|'custom_json'|'newsletter';tagId?:string};
type Action='summary'|'keywords'|'classification';
type AIRule={id:string;name:string;enabled:boolean;autoRun:boolean;needsAuthorization:boolean;lastError:string|null;conditions:Conditions;actionType:Action;maxItems:number;provider:string|null;model:string|null;stats:Record<string,number>};
type Preview={matching:number;sample:{id:string;title:string;feedTitle:string;prompt:string;chars:number;error?:string}[];provider:string;model:string;isLocal:boolean;scopeHash:string};
type Job={entry_id:string;title:string|null;status:string;attempts:number;last_error:string|null};
const names:Record<Action,string>={summary:'文章摘要',keywords:'主题关键词',classification:'主题分类建议'};

export function AIRulesSettings({feeds,tags}:{feeds:Feed[];tags:Tag[]}){
  const [rules,setRules]=useState<AIRule[]>([]),[name,setName]=useState(''),[conditions,setConditions]=useState<Conditions>({}),[actionType,setActionType]=useState<Action>('summary'),[maxItems,setMaxItems]=useState(10);
  const [draftPreview,setDraftPreview]=useState<Preview|null>(null),[selected,setSelected]=useState<{id:string;preview:Preview}|null>(null),[jobs,setJobs]=useState<Job[]>([]),[confirmSend,setConfirmSend]=useState(false),[allowRemote,setAllowRemote]=useState(false),[autoRun,setAutoRun]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const reload=async()=>{setRules(await api.get<AIRule[]>('/api/ai-rules'));if(selected)setJobs(await api.get<Job[]>(`/api/ai-rules/${selected.id}/jobs`).catch(()=>[]));};
  useEffect(()=>{void reload().catch(cause=>setError(String(cause)));const timer=setInterval(()=>void reload().catch(()=>{}),2000);return()=>clearInterval(timer);},[selected?.id]);
  const draft=()=>({name,conditions,actionType,maxItems});
  const changeCondition=(key:keyof Conditions,value:string)=>{setDraftPreview(null);setConditions(old=>{const next={...old};if(value)Object.assign(next,{[key]:value});else delete next[key];return next;});};
  const run=async(work:()=>Promise<unknown>,message?:string)=>{setBusy(true);setError('');setNotice('');try{const result=await work();await reload();if(message)setNotice(message);return result;}catch(cause){setError(String(cause));return null;}finally{setBusy(false);}};
  const previewDraft=async()=>{const result=await run(()=>api.post<Preview>('/api/ai-rules/preview',draft()));if(result)setDraftPreview(result as Preview);};
  const create=async()=>{const result=await run(()=>api.post('/api/ai-rules',draft()),'AI 规则已保存为停用。预演并明确授权后才能处理文章。');if(result){setName('');setDraftPreview(null);}};
  const previewRule=async(id:string)=>{const result=await run(()=>api.get<Preview>(`/api/ai-rules/${id}/preview`));if(result){setSelected({id,preview:result as Preview});setConfirmSend(false);setAllowRemote(false);setAutoRun(false);setJobs(await api.get<Job[]>(`/api/ai-rules/${id}/jobs`));}};
  const enable=async()=>{if(!selected)return;const result=await run(()=>api.post(`/api/ai-rules/${selected.id}/enable`,{scopeHash:selected.preview.scopeHash,confirmSend,allowRemote,autoRun}),'授权已保存。已有文章请点击“处理一批”；自动处理仅作用于此后刷新的新文章。');if(result)setConfirmSend(false);};
  const disable=async(id:string)=>{await run(()=>api.post(`/api/ai-rules/${id}/disable`,{}),'AI 规则已停用；正在进行的单篇请求可能完成，后续任务已暂停。');};
  const process=async(id:string)=>{const result=await run(()=>api.post<{queued:number}>(`/api/ai-rules/${id}/run`,{}));if(result)setNotice(`已加入 ${(result as {queued:number}).queued} 篇到本地处理队列；进度会自动更新。`);};
  const retry=async(id:string)=>{const result=await run(()=>api.post<{queued:number}>(`/api/ai-rules/${id}/retry`,{}));if(result)setNotice(`已重新排队 ${(result as {queued:number}).queued} 篇失败或中断文章。`);};
  const remove=async(id:string)=>{if(!confirm('删除这条 AI 规则及其任务记录？已生成的本地结果会保留。'))return;const result=await run(()=>api.del(`/api/ai-rules/${id}`),'AI 规则已删除，既有 AI 结果保留。');if(result&&selected?.id===id){setSelected(null);setJobs([]);}};
  const previewBlock=(preview:Preview)=><div className="rule-preview ai-rule-preview"><strong>匹配 {preview.matching} 篇 · 单批最多 {preview.sample.length} 篇</strong><p>Provider：{preview.provider}（{preview.isLocal?'本机地址':'远端地址'}）· 模型：{preview.model||'未配置'}</p><p>每篇最多发送本地正文前 40,000 字及文章标题。下方是本批实际发送文本；启用自动处理后，未来符合条件的新文章也会按同一范围发送。</p>{preview.sample.map(item=><details key={item.id}><summary>{item.feedTitle} · {item.title} · {item.chars} 字{item.error?` · ${item.error}`:''}</summary><pre>{item.prompt||'无可发送正文'}</pre></details>)}</div>;
  return <section className="ai-rules-settings">
    <h3>AI 自动规则</h3>
    <p className="muted">默认停用。摘要、关键词和分类建议会保存在本机；预演只读本地文章，不联系模型。授权固定到当前 Provider、模型、凭据、上下文预算和规则范围；更换其中任何一项后须重新预演并授权。</p>
    <div className="rule-form">
      <label>规则名称<input value={name} maxLength={80} onChange={event=>{setName(event.target.value);setDraftPreview(null);}} placeholder="例如：科研摘要"/></label>
      <label>动作<select value={actionType} onChange={event=>{setActionType(event.target.value as Action);setDraftPreview(null);}}>{Object.entries(names).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>订阅<select value={conditions.feedId||''} onChange={event=>changeCondition('feedId',event.target.value)}><option value="">任意订阅</option>{feeds.map(feed=><option key={feed.id} value={feed.id}>{feed.title}</option>)}</select></label>
      <label>单批最多处理<input type="number" min={1} max={20} value={maxItems} onChange={event=>{setMaxItems(Number(event.target.value));setDraftPreview(null);}}/></label>
      <label>标题包含<input value={conditions.titleKeyword||''} onChange={event=>changeCondition('titleKeyword',event.target.value)} placeholder="关键词"/></label>
      <label>正文包含<input value={conditions.bodyKeyword||''} onChange={event=>changeCondition('bodyKeyword',event.target.value)} placeholder="关键词"/></label>
      <label>开始日期<input type="date" value={conditions.after||''} onChange={event=>changeCondition('after',event.target.value)}/></label>
      <label>结束日期<input type="date" value={conditions.before||''} onChange={event=>changeCondition('before',event.target.value)}/></label>
      <label>订阅类型<select value={conditions.type||''} onChange={event=>changeCondition('type',event.target.value)}><option value="">任意类型</option><option value="rss">RSS/Atom/JSON Feed</option><option value="rsshub">RSSHub</option><option value="custom_json">自定义 JSON API</option><option value="newsletter">本地 Newsletter</option></select></label>
      <label>已有标签<select value={conditions.tagId||''} onChange={event=>changeCondition('tagId',event.target.value)}><option value="">不限标签</option>{tags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></label>
    </div>
    <div className="setting-actions"><button className="secondary" disabled={busy||!name.trim()} onClick={previewDraft}>预演草稿</button><button className="primary" disabled={busy||!name.trim()} onClick={create}>保存为停用规则</button></div>
    {draftPreview&&previewBlock(draftPreview)}
    <div className="rule-list">{rules.map(rule=><div className="rule-card" key={rule.id}>
      <div className="rule-card-heading"><strong>{rule.name}</strong><span>{names[rule.actionType]} · {rule.needsAuthorization?'需重新授权':rule.enabled?'已授权':'停用'}{rule.autoRun?' · 新文章自动处理':''} · 每批 {rule.maxItems} 篇</span></div>
      <p className="ai-rule-stats">排队 {rule.stats.queued||0} · 处理中 {rule.stats.running||0} · 已完成 {rule.stats.done||0} · 失败 {rule.stats.failed||0} · 暂停 {rule.stats.paused||0}</p>
      {rule.lastError&&<p className="dialog-error" role="alert">自动处理异常：{rule.lastError}</p>}
      <div className="rule-card-actions"><button className="secondary" disabled={busy} onClick={()=>previewRule(rule.id)}>预演与授权</button><button className="secondary" disabled={busy||!rule.enabled||rule.needsAuthorization} onClick={()=>process(rule.id)}>处理一批</button><button className="secondary" disabled={busy||!rule.enabled||rule.needsAuthorization||!(rule.stats.failed||rule.stats.paused)} onClick={()=>retry(rule.id)}>重试失败</button><button className="secondary" disabled={busy||!rule.enabled} onClick={()=>disable(rule.id)}>停用</button><button className="secondary danger" disabled={busy} onClick={()=>remove(rule.id)}>删除</button></div>
      {selected?.id===rule.id&&<>{previewBlock(selected.preview)}<div className="ai-rule-consent"><label><input type="checkbox" checked={confirmSend} onChange={event=>setConfirmSend(event.target.checked)}/> 我已查看发送范围，同意将匹配文章标题和正文发送到上述 Provider</label>{!selected.preview.isLocal&&<label><input type="checkbox" checked={allowRemote} onChange={event=>setAllowRemote(event.target.checked)}/> 我明确允许发送到该远端 Provider</label>}<label><input type="checkbox" checked={autoRun} onChange={event=>setAutoRun(event.target.checked)}/> 以后刷新得到的新文章自动排队处理</label><button className="primary" disabled={busy||!confirmSend||(!selected.preview.isLocal&&!allowRemote)||!selected.preview.model} onClick={enable}>保存授权与启用</button></div><div className="ai-rule-jobs">{jobs.map(job=><div key={job.entry_id}><strong>{job.title||'文章已删除'}</strong> · {job.status} · 尝试 {job.attempts} 次{job.last_error&&<small> · {job.last_error}</small>}</div>)}</div></>}
    </div>)}</div>
    {notice&&<p className="rule-notice" role="status">{notice}</p>}{error&&<p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
