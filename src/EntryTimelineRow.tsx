import {useMemo} from 'react';
import {Check,Star} from 'lucide-react';
import type {Entry} from './api';
import type {ReadingPreferences} from './reading';
import {SourceIcon} from './SourceIcon';
import {formatShortDate} from './date-display';

function snippet(html:string){
  const doc=new DOMParser().parseFromString(html,'text/html');
  doc.querySelectorAll('script,style,noscript').forEach(element=>element.remove());
  doc.querySelectorAll('p,div,br,li,h1,h2,h3,blockquote').forEach(element=>element.append('\n'));
  return doc.body.textContent?.replace(/\n{3,}/g,'\n\n').trim()||'';
}
export function EntryTimelineRow({entry,icon,iconKey,density,timeZone,selected,bulkMode,checked,onClick}:{entry:Entry;icon?:string|null;iconKey?:string|null;density:ReadingPreferences['density'];timeZone:string;selected:boolean;bulkMode:boolean;checked:boolean;onClick:()=>void}){
  const showSnippet=density!=='compact';
  const text=useMemo(()=>showSnippet?snippet(entry.description||entry.content||''):'',[entry.description,entry.content,showSnippet]);
  const date=entry.published_at||entry.fetched_at;
  const label=useMemo(()=>formatShortDate(date,timeZone),[date,timeZone]);
  return <button className={`entry-row ${selected?'selected':''} ${density}`} data-entry-id={entry.id} aria-pressed={bulkMode?checked:undefined} onClick={onClick}>
    {bulkMode&&<span className={`bulk-check ${checked?'checked':''}`}>{checked?<Check size={12}/>:null}</span>}
    <div className="entry-row-top">
      <span className="source"><SourceIcon icon={icon} iconKey={iconKey} feedId={entry.feed_id} title={entry.feed_title}/>{entry.feed_title}</span>
      <span className="entry-row-right">
        <span className="entry-flags">{!entry.read&&<span className="unread-dot"/>}{!!entry.starred&&<Star size={12} fill="currentColor" className="flag-star"/>}{!!entry.rule_muted&&<span className="flag-muted" title="本地静音">静音</span>}</span>
        <time>{label}</time>
      </span>
    </div>
    <strong className={entry.read?'read':''}>{entry.title}</strong>
    {showSnippet&&<p>{text.slice(0,density==='comfortable'?180:95)}</p>}
  </button>;
}
