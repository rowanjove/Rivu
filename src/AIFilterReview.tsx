import { useEffect,useState } from 'react';
import { api } from './api';
type Decision='keep'|'mute'|'block';
type Review={effect:{decision:Exclude<Decision,'keep'>;reason:string;criteria:string}|null;undoHash:string|null;suggestion:{decision:Decision;reason:string}|null;reviewHash:string|null};
const labels:Record<Decision,string>={keep:'保留',mute:'静音',block:'屏蔽'};
export function AIFilterReview({entryId,revision,onChanged}:{entryId:string;revision:number;onChanged:()=>Promise<void>}){
  const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0);
  useEffect(()=>{let active=true;setReview(null);setError('');setNotice('');api.get<Review>(`/api/entries/${entryId}/ai/filter-review`).then(value=>{if(active)setReview(value);}).catch(cause=>{if(active)setError(String(cause));});return()=>{active=false;};},[entryId,revision,reload]);
  const change=async(undo:boolean)=>{
    if(!review)return;setBusy(true);setError('');setNotice('');
    try{
      const next=await api.post<Review>(`/api/entries/${entryId}/ai/filter-review/${undo?'undo':'apply'}`,undo?{undoHash:review.undoHash}:{reviewHash:review.reviewHash});
      setReview(next);setNotice(undo?'已撤销本次AI过滤。其他规则的效果仍保留。':'已确认并应用到本地。文章与阅读状态保留。');await onChanged();
    }catch(cause){setError(String(cause));}finally{setBusy(false);}
  };
  if(!error&&!review?.effect&&!review?.suggestion)return null;
  return <section className="ai-result ai-filter-review" aria-label="过滤建议审阅">
    <strong>AI 内容过滤</strong>
    {review?.effect&&<div><p>当前本地过滤：{labels[review.effect.decision]}。依据：{review.effect.reason}</p><p>当时的过滤条件：{review.effect.criteria}</p><button className="secondary" disabled={busy} onClick={()=>void change(true)}>撤销本次 AI 过滤</button></div>}
    {review?.suggestion&&<div><p>建议：{labels[review.suggestion.decision]}。依据：{review.suggestion.reason}</p>
      <p>{review.suggestion.decision==='keep'?'确认保留会清除此文章已有的AI过滤；其他规则仍生效。':review.suggestion.decision==='mute'?'静音后退出收件箱，仍可从全部文章找到。':'屏蔽后进入“已屏蔽”，仍可查看和撤销。'}文章、收藏、标签与归档不会删除。</p>
      <button className="secondary" disabled={busy||!!error} onClick={()=>void change(false)}>确认{labels[review.suggestion.decision]}</button>
    </div>}
    {error&&<><p role="alert" className="ai-error">{error}</p><button className="secondary" disabled={busy} onClick={()=>setReload(value=>value+1)}>重新读取过滤状态</button></>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
