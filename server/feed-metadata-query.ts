import type {DatabaseSync} from 'node:sqlite';
import {sourceIconKey} from './source-icons';

// Keep metadata, visibility counts and icon identities within the caller's WAL snapshot.
export function queryFeedMetadata(db:DatabaseSync){
  const columns=['id','title','url','site_url','description','type','category_id','last_fetched_at','last_success_at','fetch_interval','enabled','failure_count','last_error','next_fetch_at','created_at','allow_private','json_mapping','folder_authorized','rsshub_instance_id'];
  const rows=db.prepare(`SELECT ${columns.map(column=>`f.${column}`).join(',')},c.name category_name,CASE WHEN f.enabled=0 THEN 'paused' WHEN f.failure_count>=5 THEN 'error' WHEN f.failure_count>0 THEN 'retrying' ELSE 'healthy' END health,k.icon_key,k.feed_id icon_key_feed,COALESCE(u.unread_count,0) unread_count FROM feeds f LEFT JOIN categories c ON c.id=f.category_id LEFT JOIN feed_icon_keys k ON k.feed_id=f.id LEFT JOIN rivu_feed_unread_counts u ON u.feed_id=f.id ORDER BY f.title COLLATE NOCASE`).all();
  return rows.map(({icon_key,icon_key_feed,...row})=>{
    const iconKey=icon_key_feed!==null&&(icon_key===null||typeof icon_key==='string'&&/^[a-f0-9]{64}$/.test(icon_key))?icon_key:sourceIconKey(db.prepare('SELECT icon FROM feeds WHERE id=?').get(row.id as string)?.icon);
    return {...row,icon:null,iconKey,unread_count:Number(row.unread_count)};
  });
}
