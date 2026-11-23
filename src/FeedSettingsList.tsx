import {Fragment,useEffect,useState} from 'react';
import type {ReactNode} from 'react';
import type {Feed} from './api';

const PAGE_SIZE=50;
export function FeedSettingsList({feeds,children}:{feeds:Feed[];children:(feed:Feed)=>ReactNode}){
  const [requestedPage,setPage]=useState(0),pages=Math.max(1,Math.ceil(feeds.length/PAGE_SIZE)),page=Math.min(requestedPage,pages-1);
  useEffect(()=>setPage(current=>Math.min(current,pages-1)),[pages]);
  const start=page*PAGE_SIZE,end=Math.min(start+PAGE_SIZE,feeds.length);
  return <>
    {pages>1&&<nav className="feed-settings-pagination" aria-label="订阅管理分页">
      <button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>上一页订阅</button>
      <span role="status">订阅 {start+1}–{end} / {feeds.length}</span>
      <button className="secondary" disabled={page===pages-1} onClick={()=>setPage(page+1)}>下一页订阅</button>
      <small>全选和批量操作包含所有页面的所选订阅。</small>
    </nav>}
    {feeds.slice(start,end).map(feed=><Fragment key={feed.id}>{children(feed)}</Fragment>)}
  </>;
}
