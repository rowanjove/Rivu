import {useModalFocus} from './useModalFocus';
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import type { Category, OpmlImportResult, OpmlPreview } from './api';

export function OpmlImportDialog({categories,onClose,onImported}:{categories:Category[];onClose:()=>void;onImported:()=>Promise<void>}){
  const dialogRef=useRef<HTMLDivElement>(null);useModalFocus(dialogRef,onClose);
  const [draft,setDraft]=useState<{id:string;preview:OpmlPreview}|null>(null);
  const [selected,setSelected]=useState<Set<number>>(new Set());
  const [categoryMap,setCategoryMap]=useState<Record<string,string|null>>({});
  const [result,setResult]=useState<OpmlImportResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const choose=async()=>{
    setBusy(true);setError('');setResult(null);
    try{const next=await window.rivu.previewOpml();if(next){setDraft(next);setSelected(new Set(next.preview.items.filter(item=>item.status==='new').map(item=>item.index)));setCategoryMap({});}}
    catch(cause){setError(String(cause));}
    finally{setBusy(false);}
  };
  const submit=async()=>{
    if(!draft)return;
    setBusy(true);setError('');
    try{const imported=await window.rivu.importOpml(draft.id,{selected:[...selected],categoryMap});setResult(imported);await onImported();}
    catch(cause){setError(String(cause));}
    finally{setBusy(false);}
  };
  const sources=[...new Set(draft?.preview.items.filter(item=>item.status==='new'&&item.sourceCategory).map(item=>item.sourceCategory)??[])];
  return <div className="overlay" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><div className="dialog opml-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="opml-import-title" tabIndex={-1}>
    <div className="dialog-heading"><h2 id="opml-import-title">导入 OPML</h2><button className="icon-button" title="关闭" onClick={onClose}><X size={18}/></button></div>
    <p>先检查重复与无效订阅，再决定导入范围。导入后订阅会进入本地刷新队列。</p>
    <button className="secondary" disabled={busy} onClick={choose}>{draft?'重新选择文件':'选择 OPML 文件'}</button>
    {draft&&<>
      <p className="opml-summary">可导入 {draft.preview.newCount} · 重复 {draft.preview.duplicateCount} · 无效 {draft.preview.invalidCount}</p>
      {sources.length>0&&<div className="opml-category-map"><strong>分类映射</strong>{sources.map(source=><label key={source}><span>{source}</span><select value={categoryMap[source]===undefined?'__new__':categoryMap[source]===null?'__none__':categoryMap[source]} onChange={event=>{const value=event.target.value;setCategoryMap(current=>{const next={...current};if(value==='__new__')delete next[source];else next[source]=value==='__none__'?null:value;return next;});}}><option value="__new__">新建同名分类</option><option value="__none__">不分类</option>{categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>)}</div>}
      <div className="opml-selection-actions"><button className="secondary" onClick={()=>setSelected(new Set(draft.preview.items.filter(item=>item.status==='new').map(item=>item.index)))}>选中全部可导入</button><button className="secondary" onClick={()=>setSelected(new Set())}>清空选择</button></div>
      <Virtuoso className="opml-items" style={{height:300}} data={draft.preview.items} itemContent={(_index,item)=>{const outcome=result?.results.find(row=>row.index===item.index);return <label className={item.status}><input type="checkbox" disabled={item.status!=='new'||!!result} checked={selected.has(item.index)} onChange={event=>setSelected(current=>{const next=new Set(current);if(event.target.checked)next.add(item.index);else next.delete(item.index);return next;})}/><span><strong>{item.title}</strong><small>{item.sourceCategory||'未分类'} · {item.url}</small>{item.status!=='new'&&<small>{item.status==='duplicate'?'重复':'无效'}：{item.reason}</small>}{outcome&&<small className={outcome.status==='failed'?'opml-failed':''}>{outcome.status==='imported'?'已导入':outcome.status==='failed'?`导入失败：${outcome.reason}`:`已跳过：${outcome.reason}`}</small>}</span></label>;}}/>
      {!result?<div className="dialog-actions"><button className="primary" disabled={busy||selected.size===0} onClick={submit}>{busy?'导入中…':`导入选中的 ${selected.size} 个订阅`}</button></div>:<p className="opml-summary" role="status">已导入 {result.imported} · 跳过 {result.skipped} · 失败 {result.failed}。{result.failed?'失败项可修正后重新导入。':'新订阅会在后台刷新。'}</p>}
    </>}
    {error&&<p className="dialog-error" role="alert">{error}</p>}
  </div></div>;
}
