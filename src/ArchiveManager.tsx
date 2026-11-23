import {openExternalLink,externalUrl} from './external-link';
import {formatFullDate} from './date-display';
import {useModalFocus} from './useModalFocus';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {renderArticleHtml} from './article-html';
import { api } from './api';

type Item={id:string;title:string;feed_title:string;url:string|null;created_at:string;updated_at:string;version_count:number;asset_count:number};
type Detail=Item&{revision:string;body_html:string;version_id:string;versions:{id:string;created_at:string}[];assets:{id:string;kind:string;url:string;mime:string;bytes:number}[]};
type Stats={count:number;assets:number;bytes:number;quotaBytes:number};
type Page<T>={items:T[];hasNext:boolean;total:number;revision:string;stats:Stats};
const changed=(error:unknown)=>String(error).includes("归档内容已变化");
const size=(bytes:number)=>`${(bytes/1024/1024).toFixed(1)} MiB`;

export function ArchiveManager({onClose}:{onClose:()=>void}){
  const dialogRef=useRef<HTMLDivElement>(null);useModalFocus(dialogRef,onClose);
  const [items,setItems]=useState<Item[]>([]),[detail,setDetail]=useState<Detail|null>(null),[stats,setStats]=useState<Stats|null>(null),[version,setVersion]=useState(''),[body,setBody]=useState(''),[error,setError]=useState('');
  const [offset,setOffset]=useState(0),[versionOffset,setVersionOffset]=useState(0),[listRevision,setListRevision]=useState(''),[hasNext,setHasNext]=useState(false),[notice,setNotice]=useState(''),[loading,setLoading]=useState(false),[versionLoading,setVersionLoading]=useState(false);
  const listGeneration=useRef(0),detailGeneration=useRef(0);
  const bodyRef=useRef<HTMLDivElement>(null),[imageError,setImageError]=useState(''),[imageAttempt,setImageAttempt]=useState(0);
  const load=async(nextOffset=0,expected?:string)=>{
    const generation=++listGeneration.current;setLoading(true);
    try{
      let page:Page<Item>;let actualOffset=nextOffset;
      try{page=await api.get<Page<Item>>(`/api/archives/page?limit=100&offset=${nextOffset}${expected===undefined?'':`&revision=${expected}`}`);}
      catch(e){if(generation!==listGeneration.current)return;if(!changed(e))throw e;page=await api.get<Page<Item>>('/api/archives/page?limit=100&offset=0');actualOffset=0;if(generation===listGeneration.current)setNotice('归档内容已变化，已刷新到第一页。');}
      if(generation!==listGeneration.current)return;setItems(page.items);setStats(page.stats);setOffset(actualOffset);setListRevision(page.revision);setHasNext(page.hasNext);setError('');
    }catch(e){if(generation===listGeneration.current)setError(String(e));}finally{if(generation===listGeneration.current)setLoading(false);}
  };
  useEffect(()=>{void load();},[]);
  const open=async(id:string,recovering=false)=>{const generation=++detailGeneration.current;setVersionLoading(true);try{const next=await api.get<Detail>(`/api/archives/${id}`);if(generation!==detailGeneration.current)return;setDetail(next);setVersionOffset(0);setVersion(next.version_id);setBody(next.body_html);setError('');if(recovering)setNotice('归档内容已变化，已重新打开最新版本。');}catch(e){if(generation===detailGeneration.current){setDetail(null);setError(String(e));if(recovering)setNotice('归档内容已变化，无法重新打开归档。');}}finally{if(generation===detailGeneration.current)setVersionLoading(false);}};
  const detailFailure=async(e:unknown,generation:number,id:string)=>{if(generation!==detailGeneration.current)return;if(changed(e)){await open(id,true);}else setError(String(e));};
  const selectVersion=async(id:string)=>{if(!detail)return;const generation=++detailGeneration.current;setVersionLoading(true);try{const result=await api.get<{body_html:string;assets:Detail['assets']}>(`/api/archives/${detail.id}/versions/${id}?revision=${detail.revision}`);if(generation!==detailGeneration.current)return;setVersion(id);setBody(result.body_html);setDetail(old=>old?.id===detail.id?{...old,assets:result.assets}:old);}catch(e){await detailFailure(e,generation,detail.id);}finally{if(generation===detailGeneration.current)setVersionLoading(false);}};
  const loadVersions=async(nextOffset:number)=>{if(!detail)return;const generation=++detailGeneration.current;setVersionLoading(true);try{const page=await api.get<Page<Detail['versions'][number]>>(`/api/archives/${detail.id}/versions/page?limit=100&offset=${nextOffset}&revision=${detail.revision}`);if(generation!==detailGeneration.current)return;if(!page.items.length)throw Error('该页没有历史版本，请重新打开归档');const result=await api.get<{body_html:string;assets:Detail['assets']}>(`/api/archives/${detail.id}/versions/${page.items[0].id}?revision=${page.revision}`);if(generation!==detailGeneration.current)return;setVersionOffset(nextOffset);setVersion(page.items[0].id);setBody(result.body_html);setDetail(old=>old?.id===detail.id?{...old,revision:page.revision,version_count:page.total,versions:page.items,assets:result.assets}:old);}catch(e){await detailFailure(e,generation,detail.id);}finally{if(generation===detailGeneration.current)setVersionLoading(false);}};
  const listControls=<div className="setting-actions"><button className="secondary" disabled={loading} onClick={()=>{setNotice('');void load();}}>刷新归档</button><button className="secondary" disabled={loading||offset===0} onClick={()=>void load(Math.max(0,offset-100),listRevision)}>上一页归档</button><span>第 {Math.floor(offset/100)+1} 页</span><button className="secondary" disabled={loading||!hasNext} onClick={()=>void load(offset+100,listRevision)}>下一页归档</button></div>;
  const versionControls=detail&&<><button className="secondary" disabled={versionLoading||versionOffset===0} onClick={()=>void loadVersions(Math.max(0,versionOffset-100))}>较新版本</button><button className="secondary" disabled={versionLoading||versionOffset+detail.versions.length>=detail.version_count} onClick={()=>void loadVersions(versionOffset+100)}>较早版本</button></>;
  const html=useMemo(()=>detail?renderArticleHtml(body,{kind:'archive',baseUrl:detail.url,assets:detail.assets}):'',[body,detail]);
  useEffect(()=>{
    if(!detail||!bodyRef.current)return;let active=true,cursor=0;setImageError('');
    const groups=new Map<string,HTMLImageElement[]>();
    for(const image of bodyRef.current.querySelectorAll<HTMLImageElement>('img[data-archive-asset]')){const id=image.dataset.archiveAsset!;groups.set(id,[...(groups.get(id)||[]),image]);}
    const jobs=[...groups];
    const run=async()=>{while(active&&cursor<jobs.length){const [id,images]=jobs[cursor++];try{
      let result:{dataUrl:string}|undefined;
      for(let attempt=0;active;attempt++){try{result=await api.get<{dataUrl:string}>(`/api/archives/${detail.id}/assets/${id}`);break;}catch(error){if(attempt>=2||!/繁忙|超时/.test(String(error)))throw error;await new Promise(resolve=>setTimeout(resolve,100*(attempt+1)));}}
      if(active&&result)for(const image of images)image.src=result.dataUrl;
    }catch(error){if(active)setImageError(`部分归档图片未能加载：${String(error)}`);}}};
    void Promise.all([run(),run()]);return()=>{active=false;};
  },[html,detail,imageAttempt]);
  const imageFeedback=imageError&&<p role="alert" className="article-error">{imageError} <button className="secondary" onClick={()=>setImageAttempt(value=>value+1)}>重试归档图片</button></p>;
  return <div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className="settings-dialog archive-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="archive-manager-title" tabIndex={-1}><header className="dialog-heading"><h2 id="archive-manager-title">永久归档</h2><button className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={18}/></button></header><div className="settings-scroll"><p className="muted">已归档 {stats?.count||0} 篇，正文和资源占用 {size(stats?.bytes||0)} / {size(stats?.quotaBytes||0)}。归档独立于订阅；删除订阅后仍可阅读和导出。</p>{notice&&<p role="status" className="muted">{notice}</p>}{error&&<p role="alert" className="article-error">{error}</p>}<div className="archive-layout"><div className="archive-list">{listControls}{items.length?items.map(item=><button key={item.id} className={`archive-item ${detail?.id===item.id?'active':''}`} onClick={()=>open(item.id)}><strong>{item.title}</strong><span>{item.feed_title} · {item.version_count} 个版本 · {item.asset_count} 个资源</span></button>):<p className="muted">还没有永久归档。打开文章后选择“永久归档”。</p>}</div><div className="archive-detail">{detail?<><h3>{detail.title}</h3><p className="muted">{detail.feed_title} · {formatFullDate(detail.created_at)}</p><div className="setting-actions"><label>版本 <select disabled={versionLoading} value={version} onChange={e=>selectVersion(e.target.value)}>{detail.versions.map((v,i)=><option key={v.id} value={v.id}>{versionOffset===0&&i===0?'最新 · ':''}{formatFullDate(v.created_at)}</option>)}</select></label>{versionControls}<button className="secondary" onClick={async()=>{try{await window.rivu.saveFile('archive',{archiveId:detail.id});}catch(e){setError(String(e));}}}>导出独立 ZIP</button><button className="secondary danger" onClick={async()=>{if(!confirm(`删除永久归档《${detail.title}》及其历史版本？`))return;try{await api.del(`/api/archives/${detail.id}`);detailGeneration.current++;setDetail(null);await load();}catch(e){setError(String(e));}}}>删除归档</button></div>{imageFeedback}<div ref={bodyRef} className="archive-body rich-body" onClick={e=>{const a=(e.target as HTMLElement).closest('a');if(!a)return;e.preventDefault();const href=a.getAttribute('href');if(href&&externalUrl(href)&&confirm(`在浏览器打开此链接？\n${href}`))void openExternalLink(href,setError);}} dangerouslySetInnerHTML={{__html:html}}/>{detail.assets.filter(a=>a.kind==='audio'||a.kind==='video'||a.kind==='snapshot').map(a=><p key={a.id}>{a.kind==='snapshot'?'来源快照':a.kind==='audio'?'音频':'视频'} · {size(a.bytes)} · 已包含在导出 ZIP 中</p>)}</>:<p className="muted">选择一篇归档阅读。</p>}</div></div></div></div></div>;
}
