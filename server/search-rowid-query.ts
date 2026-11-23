import type {DatabaseSync} from 'node:sqlite';
import {withSearchPostingBits,type SearchPosting,type PostingBitsResult} from './search-posting-bits';
type Syntax={blocked:string;muted:string;indexedLong:string;frequentLong:string;indexedPair:string;frequentPair:string};
type Input={where:readonly string[];args:readonly (string|number|null)[];syntax:Syntax;view?:string;feedId?:string;limit:number;offset:number};

// Accept only application-owned predicate forms. Unknown combinations use the
// original query, with all of its parameters and semantics retained.
export function trySearchRowidPage<T>(db:DatabaseSync,input:Input,hydrate:(ids:string[])=>T):PostingBitsResult<T>{
 if(!db.isTransaction)return {accepted:false,reason:'snapshot-required'};
 if(!Number.isSafeInteger(input.offset)||!Number.isSafeInteger(input.offset+input.limit))return {accepted:false,reason:'offset-range'};
 const {syntax}=input;
 if(!['all','unread','blocked'].includes(input.view||'all')||(input.view==='unread'&&input.where.includes(syntax.blocked)))return {accepted:false,reason:'view'};
 const conditions:string[]=[],values:(string|number|null)[]=[],postings:SearchPosting[]=[];let consumed=0,scoped=false;
 for(const part of input.where){
  const count=(part.match(/\?/g)||[]).length,args=input.args.slice(consumed,consumed+count);consumed+=count;
  const long=part===syntax.indexedLong||part===syntax.frequentLong,pair=part===syntax.indexedPair||part===syntax.frequentPair;
  if(long||pair){
   const indexed=long?syntax.indexedLong:syntax.indexedPair;
   if(!indexed.startsWith('e.rowid IN (')||!indexed.endsWith(')'))return {accepted:false,reason:'posting-shape'};
   postings.push({sql:`SELECT rowid entry_rowid FROM (${indexed.slice(12,-1)})`,args});continue;
  }
  let mapped:string;
  if(part===`NOT ${syntax.blocked}`)mapped='s.blocked=0';
  else if(part===syntax.blocked)mapped='s.blocked=1';
  else if(part===`NOT ${syntax.muted}`&&input.view==='unread')mapped='s.visible=1';
  // Visibility also depends on read/block state, so it cannot prove mute
  // membership. Retain the original rule/AI predicate on the candidate ID.
  else if(part===syntax.muted)mapped=part.replaceAll('e.id','s.entry_id');
  else if(part==='e.read=0')mapped='s.read=0';
  else if(part==='e.feed_id=?'){mapped='s.feed_id=?';scoped=true;}
  else if(part==='f.category_id=?'){mapped='s.feed_id IN (SELECT id FROM feeds WHERE category_id=?)';scoped=true;}
  else if(part==='f.title LIKE ?'){mapped='s.feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)';scoped=true;}
  else if(part==='(COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?))'||/^(?:COALESCE\(e\.published_at,e\.fetched_at\)|substr\(COALESCE\(e\.published_at,e\.fetched_at\),1,10\))(?:>=|<)\?$/.test(part))mapped=part.replaceAll('COALESCE(e.published_at,e.fetched_at)','s.sort_time').replaceAll('e.id','s.entry_id');
  else return {accepted:false,reason:'predicate'};
  conditions.push(mapped);values.push(...args);
 }
 if(consumed!==input.args.length||!postings.length)return {accepted:false,reason:'parameters'};
 return withSearchPostingBits(db,postings,(names,counts,_packed,byteMembership,intersectRows)=>{
  const catalog=db.prepare('SELECT NOT EXISTS(SELECT 1 FROM rivu_source_entry_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL) valid,(SELECT sum(entry_count) FROM rivu_source_entry_counts) total').get() as {valid:number;total:number};
  if(!catalog.valid)conditions.push('EXISTS(SELECT 1 FROM feeds f WHERE f.id=s.feed_id)');
  const smallest=counts.indexOf(Math.min(...counts));
  if(!input.feedId&&counts[smallest]<=100000&&catalog.total>counts[smallest]*4){
   // Intersect the bounded postings before SQLite probes and sorts candidate
   // rows. This also removes article/summary duplicates from the JSON input.
   const candidates=intersectRows();
   if(input.offset>=candidates.length)return hydrate([]);
   const candidate=JSON.stringify(candidates);
   // NOT INDEXED still permits INTEGER PRIMARY KEY probes. Without it SQLite
   // can prefer a whole-library time scan just to avoid the candidate sort.
   const base=`FROM rivu_search_entries s NOT INDEXED WHERE s.entry_rowid IN (SELECT value FROM json_each(?)) AND ${conditions.length?conditions.join(' AND '):'1'}`;
   if(input.offset<=candidates.length/4){
    const rows=db.prepare(`SELECT s.entry_id id ${base} ORDER BY s.sort_time DESC,s.entry_id DESC LIMIT ? OFFSET ?`).all(candidate,...values,input.limit,input.offset) as {id:string}[];
    return hydrate(rows.map(row=>row.id));
   }
   if(input.offset>=candidates.length/2){
    // Reverse pagination still needs the exact count after applying filters.
    const count=(db.prepare(`SELECT count(*) n ${base}`).get(candidate,...values) as {n:number}).n;
    if(input.offset>=count)return hydrate([]);
    if(input.offset>count/2){
     const pageSize=Math.min(input.limit,count-input.offset),reverseOffset=count-input.offset-pageSize;
     const rows=db.prepare(`SELECT s.entry_id id ${base} ORDER BY s.sort_time ASC,s.entry_id ASC LIMIT ? OFFSET ?`).all(candidate,...values,pageSize,reverseOffset) as {id:string}[];
     return hydrate(rows.reverse().map(row=>row.id));
    }
   }
   const sql=`WITH ranked AS (SELECT s.entry_id,ROW_NUMBER() OVER (ORDER BY s.sort_time DESC,s.entry_id DESC) ordinal ${base}) SELECT entry_id id FROM ranked WHERE ordinal>? AND ordinal<=? ORDER BY ordinal`;
   const rows=db.prepare(sql).all(candidate,...values,input.offset,input.offset+input.limit) as {id:string}[];
   return hydrate(rows.map(row=>row.id));
  }
  const index=input.feedId?'rivu_search_feed':scoped?'rivu_search_timeline':'rivu_search_unscoped';
  // A bounded binary lookup avoids a JS call for each skipped row. Keep the
  // range check because SQLite substr accepts negative positions from the end.
  const membership=input.offset>=input.limit?byteMembership():null;
  const membershipValues=membership?[membership.lo,membership.hi,membership.bytes,membership.lo]:[];
  const binaryPredicate="s.entry_rowid BETWEEN ? AND ? AND substr(?,s.entry_rowid-?+1,1)=X'01'";
  if(membership&&conditions.length===1&&conditions[0]==='s.blocked=0'&&input.offset>membership.count/2&&membership.bytes.length===catalog.total){
   // A dense rowid interval makes the deduplicated posting count exact before
   // filtering. Only blocked rows need to be counted to find the visible tail.
   const articles=db.prepare('SELECT count(*) n FROM entries INDEXED BY entries_ai_identity').get() as {n:number};
   if(articles.n===membership.bytes.length){
    const blocked=db.prepare(`SELECT count(*) n FROM rivu_search_entries s INDEXED BY rivu_search_unscoped WHERE s.blocked=1 AND ${binaryPredicate}`).get(...membershipValues) as {n:number};
    const count=membership.count-blocked.n;
    if(input.offset>=count)return hydrate([]);
    const size=Math.min(input.limit,count-input.offset);
    const rows=db.prepare(`SELECT s.entry_id id FROM rivu_search_entries s INDEXED BY rivu_search_unscoped WHERE s.blocked=0 AND ${binaryPredicate} ORDER BY s.sort_time ASC,s.entry_id ASC LIMIT ? OFFSET ?`).all(...membershipValues,size,count-input.offset-size) as {id:string}[];
    return hydrate(rows.reverse().map(row=>row.id));
   }
  }
  if(membership)conditions.push(binaryPredicate);
  else conditions.push(...names.map(name=>`${name}(s.entry_rowid)`));
  const rows=db.prepare(`SELECT s.entry_id id FROM rivu_search_entries s INDEXED BY ${index} WHERE ${conditions.join(' AND ')} ORDER BY s.sort_time DESC,s.entry_id DESC LIMIT ? OFFSET ?`).all(...values,...membershipValues,input.limit,input.offset) as {id:string}[];
  return hydrate(rows.map(row=>row.id));
 });
}
