import { useEffect, useState } from 'react';
import { api } from './api';

type Review={tags:{name:string;reason:string}[];reviewHash:string};
export function AITagSuggestions({entryId,revision,onChanged}:{entryId:string;revision:number;onChanged:()=>Promise<void>}){
  const [review,setReview]=useState<Review|null>(null),[selected,setSelected]=useState<string[]>([]),
    [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
  useEffect(()=>{
    let active=true;
    setReview(null);setSelected([]);setNotice('');setError('');
    api.get<Review|null>(`/api/entries/${entryId}/ai/tag-suggestions`)
      .then(value=>{if(active)setReview(value);}).catch(cause=>{if(active)setError(String(cause));});
    return()=>{active=false;};
  },[entryId,revision,reload]);
  const apply=async()=>{
    if(!review||!selected.length)return;
    setBusy(true);setError('');setNotice('');
    try{
      await api.post(`/api/entries/${entryId}/ai/tag-suggestions/apply`,{names:selected,reviewHash:review.reviewHash});
      setSelected([]);setNotice('已追加为本地手动标签，可在文章标签中移除。');
      await onChanged();
    }catch(cause){setError(String(cause));}
    finally{setBusy(false);}
  };
  if(!review&&!error)return null;
  return <section className="ai-result ai-tag-suggestions" aria-label="标签建议审阅">
    <strong>标签建议</strong>
    <p>逐项审阅正文依据，勾选后追加到本地标签。已有手动和规则标签会保留。</p>
    {review?.tags.map(tag=><label key={tag.name} className="ai-tag-candidate">
      <input type="checkbox" disabled={busy} checked={selected.includes(tag.name)}
        onChange={event=>setSelected(old=>event.target.checked?[...old,tag.name]:old.filter(name=>name!==tag.name))}/>
      <span><strong>{tag.name}</strong><small>{tag.reason}</small></span>
    </label>)}
    {review&&!review.tags.length&&<p>没有有据可依的标签建议。</p>}
    {review&&<button className="secondary" disabled={busy||!selected.length||!!error} onClick={()=>void apply()}>{busy?'正在应用…':`应用选中的 ${selected.length} 个标签`}</button>}
    {error&&<><p role="alert" className="ai-error">{error}</p><button className="secondary" disabled={busy} onClick={()=>setReload(value=>value+1)}>重新读取标签建议</button></>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
