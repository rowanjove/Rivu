import type {RivuDatabase} from './database';
const sourceFields=['url','feed_id','feed_url','feed_allow_private','hash','content','description','full_content'] as const;
export function entrySourceSnapshot(entry:Record<string,unknown>){return Object.fromEntries(sourceFields.map(field=>[field,entry[field]??null]));}
export function assertEntrySourceUnchanged(db:RivuDatabase,id:string,before:Record<string,unknown>){
  const current=db.entry(id);
  if(!current)throw Object.assign(Error('文章已删除'),{statusCode:404});
  if(sourceFields.some(field=>(current[field]??null)!==(before[field]??null)))throw Object.assign(Error('文章内容、来源或网络授权已变化，请重试'),{statusCode:409});
  return current;
}
