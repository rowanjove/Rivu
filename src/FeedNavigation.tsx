import {memo} from 'react';
import type {Feed} from './api';
import {SourceIcon} from './SourceIcon';

type SelectFeed=(id:string,title:string)=>void;
const FeedRow=memo(function FeedRow({id,title,icon,iconKey,unreadCount,active,onSelect}:{id:string;title:string;icon?:string|null;iconKey?:string|null;unreadCount:number;active:boolean;onSelect:SelectFeed}){
  return <button aria-label={title} title={unreadCount>0?`${title} · ${unreadCount} 未读`:title} className={`nav-item feed-nav ${active?'active':''}`} onClick={()=>onSelect(id,title)}>
    <SourceIcon icon={icon} iconKey={iconKey} feedId={id} title={title}/>
    <span title={title}>{title}</span>
    {unreadCount>0&&<small>{unreadCount}</small>}
  </button>;
});

// Article selection does not change navigation; metadata updates render only changed rows.
export const FeedNavigation=memo(function FeedNavigation({feeds,activeId,onSelect}:{feeds:Feed[];activeId?:string;onSelect:SelectFeed}){
  return <>{feeds.map(feed=><FeedRow key={feed.id} id={feed.id} title={feed.title} icon={feed.icon} iconKey={feed.iconKey} unreadCount={feed.unread_count} active={activeId===feed.id} onSelect={onSelect}/>)}</>;
});
