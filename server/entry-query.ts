import type {DatabaseSync} from 'node:sqlite';
import {pairTerm} from './search-pairs';
import {universalSearchProof} from './search-universal-proof';
import {trySearchRowidPage} from './search-rowid-query';
import {summaryCandidateMatch} from './ai-search-candidate';
export type EntryQueryOptions={view?:string;feedId?:string;categoryId?:string;tagId?:string;limit?:number;offset?:number;query?:string;cursor?:{sortTime:string;id:string};listOnly?:boolean};
export const entryColumns=['id','feed_id','guid','title','author','url','published_at','fetched_at','content','description','cover','language','read','starred','archived','saved','hash','full_content','full_content_fetched_at','body_revision'];
const ruleEffect=(type:'save'|'mute'|'block')=>`(EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='${type}')${type==='save'?'':` OR EXISTS (SELECT 1 FROM ai_filter_decisions WHERE entry_id=e.id AND decision='${type}')`})`;
export const blocked=ruleEffect('block'),muted=ruleEffect('mute'),ruleSaved=ruleEffect('save');
const entryRuleColumns=[{name:'rule_saved',expression:`CASE WHEN ${ruleSaved} THEN 1 ELSE 0 END`},{name:'rule_muted',expression:`CASE WHEN ${muted} THEN 1 ELSE 0 END`},{name:'rule_blocked',expression:`CASE WHEN ${blocked} THEN 1 ELSE 0 END`}];
export const ruleFields=entryRuleColumns.map(({name,expression})=>`${expression} ${name}`).join(',');
const searchDate=(value:string)=>{const relative=value.match(/^(\d{1,4})d$/i);return relative?new Date(Date.now()-Number(relative[1])*86_400_000).toISOString().slice(0,10):value;};
// Increment the final ASCII digit as a lexical prefix bound, including month/year edges.
const todayPrefix="date('now','localtime')";
const todayPrefixEnd=`substr(${todayPrefix},1,9)||char(unicode(substr(${todayPrefix},10,1))+1)`;
// These are per-article probes. Keep the entry's summaries before FTS so newer
// SQLite planners cannot rescan the entire matching summary set for every row.
// Set-based posting queries below intentionally retain their ordinary JOIN.
const frequentSearchPredicate="(EXISTS (SELECT 1 FROM entry_fts WHERE rowid=e.rowid AND entry_fts MATCH ?) OR EXISTS (SELECT 1 FROM ai_results a CROSS JOIN ai_result_fts ON ai_result_fts.rowid=a.rowid WHERE a.entry_id=e.id AND a.type='summary' AND ai_result_fts MATCH ? AND a.content LIKE ?))";
const indexedSearchPredicate="e.rowid IN (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? UNION ALL SELECT e2.rowid FROM ai_result_fts JOIN ai_results a ON a.rowid=ai_result_fts.rowid JOIN entries e2 ON e2.id=a.entry_id WHERE ai_result_fts MATCH ? AND a.type='summary' AND a.content LIKE ?)";
const frequentPairPredicate="(EXISTS (SELECT 1 FROM entry_pair_fts WHERE rowid=e.rowid AND entry_pair_fts MATCH ?) OR EXISTS (SELECT 1 FROM ai_results a CROSS JOIN ai_result_pair_fts ON ai_result_pair_fts.rowid=a.rowid WHERE a.entry_id=e.id AND a.type='summary' AND ai_result_pair_fts MATCH ?))";
const indexedPairPredicate="e.rowid IN (SELECT rowid FROM entry_pair_fts WHERE entry_pair_fts MATCH ? UNION ALL SELECT e2.rowid FROM ai_result_pair_fts JOIN ai_results a ON a.rowid=ai_result_pair_fts.rowid JOIN entries e2 ON e2.id=a.entry_id WHERE ai_result_pair_fts MATCH ? AND a.type='summary')";

const bodyColumns=new Set(['content','description','full_content']);
const entryDetailColumns=[...entryColumns.map(name=>({name,expression:`${bodyColumns.has(name)?'e':'m'}.${name}`})),
  {name:'feed_title',expression:'f.title'},{name:'feed_site_url',expression:'f.site_url'},{name:'feed_url',expression:'f.url'},{name:'feed_allow_private',expression:'f.allow_private'},...entryRuleColumns];
const entryDetailFrom='FROM entries e JOIN entries m INDEXED BY entries_list_metadata ON m.id=e.id JOIN feeds f ON f.id=m.feed_id WHERE e.id=?';
export function queryEntry(db:DatabaseSync,id:string,metadataOnly=false){
  const fields=entryDetailColumns.filter(({name})=>!metadataOnly||!bodyColumns.has(name)).map(({name,expression})=>`${expression} ${name}`).join(',');
  return db.prepare(`SELECT ${fields} ${entryDetailFrom}`).get(id);
}
// Both representations use the same projection and joins. Body bytes stay UTF-8
// in the read Worker instead of passing through a large JS UTF-16 object first.
const entryJsonFields=entryDetailColumns.map(({name,expression})=>`'${name}',${expression}`).join(',');
export function queryEntryJsonBytes(db:DatabaseSync,id:string){
  return db.prepare(`SELECT CAST(json_object(${entryJsonFields}) AS BLOB) json,CAST(coalesce(nullif(e.full_content,''),nullif(e.content,''),e.description,'') AS BLOB) image_body,m.cover image_cover ${entryDetailFrom}`).get(id);
}

export function queryEntries(db:DatabaseSync,opts:EntryQueryOptions={}){
    const ownsSnapshot=!!opts.query&&!db.isTransaction;
    if(ownsSnapshot)db.exec('BEGIN');
    try{return queryEntriesInSnapshot(db,opts);}finally{if(ownsSnapshot)db.exec('ROLLBACK');}
}
function queryEntriesInSnapshot(db:DatabaseSync,opts:EntryQueryOptions){
    const provesUniversal=opts.offset&&opts.query?universalSearchProof(db):undefined;
    const where:string[]=[]; const args:(string|number|null)[]=[];
    let hasFrequentTerm=false,hasSelectiveTerm=false;
    let canBoundFrequent=true,projectionQuerySafe=true,bucketCountQuerySafe=true;
    const bucketDateWhere:string[]=[],bucketDateArgs:string[]=[],bucketSourceWhere:string[]=[],bucketSourceArgs:(string|number|null)[]=[];
    const limit=opts.limit??100,offset=opts.offset??0;
    if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0)throw Object.assign(Error('分页参数无效'),{statusCode:400});
    if(opts.cursor){
      if(typeof opts.cursor.sortTime!=='string'||opts.cursor.sortTime.length>100||!opts.cursor.sortTime||typeof opts.cursor.id!=='string'||!/^[0-9a-f-]{36}$/i.test(opts.cursor.id)||opts.offset)throw Object.assign(Error('分页游标无效'),{statusCode:400});
      where.push('(COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?))');args.push(opts.cursor.sortTime,opts.cursor.sortTime,opts.cursor.id);
    }
    if(opts.feedId){where.push('e.feed_id=?');args.push(opts.feedId);} if(opts.categoryId){where.push('f.category_id=?');args.push(opts.categoryId);bucketSourceWhere.push('feed_id IN (SELECT id FROM feeds WHERE category_id=?)');bucketSourceArgs.push(opts.categoryId);}
    if(opts.tagId){where.push("(EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id=e.id AND et.tag_id=?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND rr.tag_id=?))");args.push(opts.tagId,opts.tagId);}
    if(opts.view==='images'||opts.view==='audio'||opts.view==='video'){where.push('EXISTS (SELECT 1 FROM entry_media em WHERE em.entry_id=e.id AND em.kind=?)');args.push(opts.view==='images'?'image':opts.view);}
    if(opts.view==='blocked'||/(?:^|\s)is:blocked(?:\s|$)/i.test(opts.query||''))where.push(blocked);else where.push(`NOT ${blocked}`);
    if(opts.view==='unread'){where.push('e.read=0');where.push(`NOT ${muted}`);} if(opts.view==='starred')where.push('e.starred=1'); if(opts.view==='saved')where.push(`(e.saved=1 OR ${ruleSaved})`); if(opts.view==='today')where.push(`(e.published_at>=${todayPrefix} AND e.published_at<(${todayPrefixEnd}))`); if(opts.view==='summary')where.push("EXISTS (SELECT 1 FROM ai_results a WHERE a.entry_id=e.id AND a.type='summary')");
    if(opts.query){
      if(opts.query.length>256)throw Object.assign(Error('搜索内容过长'),{statusCode:400});
      const terms:string[]=[];
      for(const token of opts.query.match(/(?:[^\s"]+|"[^"]*")+/g)??[]){
        const match=token.match(/^(feed|tag|is|after|before):(.+)$/i);
        if(!match){if(token.toUpperCase()!=='AND')terms.push(token.replace(/^"|"$/g,''));continue;}
        if(!['after','before','feed'].includes(match[1].toLowerCase()))bucketCountQuerySafe=false;
        const kind=match[1].toLowerCase(),rawValue=match[2],unquoted=rawValue.startsWith('"')&&rawValue.endsWith('"')?rawValue.slice(1,-1):rawValue,value=kind==='is'?unquoted.toLowerCase():unquoted;
        if(kind==='feed'){where.push('f.title LIKE ?');args.push(`%${value}%`);bucketSourceWhere.push('feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)');bucketSourceArgs.push(`%${value}%`);}
        else if(kind==='tag'){where.push("(EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=e.id AND t.name LIKE ?) OR EXISTS (SELECT 1 FROM rule_matches rm JOIN rules rr ON rr.id=rm.rule_id JOIN tags t ON t.id=rr.tag_id WHERE rm.entry_id=e.id AND rr.enabled=1 AND rr.action_type='tag' AND t.name LIKE ?))");args.push(`%${value}%`,`%${value}%`);}
        else if(kind==='is'&&value==='starred')where.push('e.starred=1');
        else if(kind==='is'&&value==='unread')where.push('e.read=0');
        else if(kind==='is'&&value==='saved')where.push(`(e.saved=1 OR ${ruleSaved})`);
        else if(kind==='is'&&value==='muted')where.push(muted);
        else if(kind==='after'||kind==='before'){
          bucketDateWhere.push(`sort_bucket${kind==='after'?'>=':'<'}?`);
          const day=searchDate(value),field=/^\d{4}-\d{2}-\d{2}$/.test(day)?'COALESCE(e.published_at,e.fetched_at)':'substr(COALESCE(e.published_at,e.fetched_at),1,10)';
          where.push(`${field}${kind==='after'?'>=':'<'}?`);args.push(day);bucketDateArgs.push(day);
        }
      }
      if(terms.length>8)throw Object.assign(Error('搜索关键词过多'),{statusCode:400});
      for(const term of terms){
        if(Array.from(term).length>=3){
          const match=`"${term.replaceAll('"','""')}"`;
          const count=db.prepare('SELECT count(*) n FROM (SELECT rowid FROM entry_fts WHERE entry_fts MATCH ? UNION ALL SELECT rowid FROM ai_result_fts WHERE ai_result_fts MATCH ? LIMIT 1001)').get(match,match) as {n:number};
          if(count.n>1000&&provesUniversal?.('entry_fts',match))continue;
          const aiMatch=summaryCandidateMatch(db,term,match,count.n>1000);
          projectionQuerySafe=false;
          if(count.n>1000){hasFrequentTerm=true;where.push(frequentSearchPredicate);if(/[%_]/.test(term))canBoundFrequent=false;args.push(match,aiMatch,`%${term}%`);}
          else{hasSelectiveTerm=true;where.push(indexedSearchPredicate);args.push(match,aiMatch,`%${term}%`);}
        }
        else if(Array.from(term).length>=1&&!/[%_]/.test(term)){
          const token=pairTerm(term);
          const count=db.prepare('SELECT count(*) n FROM (SELECT rowid FROM entry_pair_fts WHERE entry_pair_fts MATCH ? UNION ALL SELECT rowid FROM ai_result_pair_fts WHERE ai_result_pair_fts MATCH ? LIMIT 1001)').get(token,token) as {n:number};
          if(count.n>1000&&provesUniversal?.('entry_pair_fts',token))continue;
          projectionQuerySafe=false;
          if(count.n>1000){hasFrequentTerm=true;where.push(frequentPairPredicate);}else{hasSelectiveTerm=true;where.push(indexedPairPredicate);}
          args.push(token,token);
        }
        else{projectionQuerySafe=false;where.push("e.rowid IN (SELECT e2.rowid FROM entries e2 WHERE e2.title LIKE ? OR e2.content LIKE ? OR e2.description LIKE ? OR e2.author LIKE ? UNION SELECT e3.rowid FROM ai_results a JOIN entries e3 ON e3.id=a.entry_id WHERE a.type='summary' AND a.content LIKE ?)");for(let i=0;i<5;i++)args.push(`%${term}%`);}
      }
    }
    const fields=opts.listOnly?`e.id,e.feed_id,e.title,e.author,e.url,e.published_at,e.fetched_at,substr(e.content,1,512) content,substr(e.description,1,512) description,e.cover,e.read,e.starred,e.saved`:entryColumns.map(column=>`${['content','description','full_content'].includes(column)?'e':'m'}.${column}`).join(',');
    const metadataJoin=opts.listOnly?'':' JOIN entries m INDEXED BY entries_list_metadata ON m.id=e.id';
    const select=`SELECT ${fields},f.title feed_title,f.site_url feed_site_url,${ruleFields}`;
    const order='ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT ? OFFSET ?';
    const fallbackWhere=hasFrequentTerm&&!hasSelectiveTerm?where.map(part=>part===frequentSearchPredicate?indexedSearchPredicate:part===frequentPairPredicate?indexedPairPredicate:part):where;
    const readPostingPage=()=>{
      if(!opts.query||!hasFrequentTerm||hasSelectiveTerm||projectionQuerySafe)return undefined;
      const fast=trySearchRowidPage(db,{where:fallbackWhere,args,view:opts.view,feedId:opts.feedId,limit,offset,syntax:{blocked,muted,indexedLong:indexedSearchPredicate,frequentLong:frequentSearchPredicate,indexedPair:indexedPairPredicate,frequentPair:frequentPairPredicate}},ids=>{
        if(!ids.length)return [];
        const values=ids.map(()=>'(?,?)').join(','),parameters=ids.flatMap((id,index)=>[id,index]);
        return db.prepare(`WITH selected(id,ordinal) AS (VALUES ${values}) ${select} FROM selected CROSS JOIN entries e${opts.listOnly?' INDEXED BY entries_list_metadata':''} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=e.feed_id ORDER BY selected.ordinal`).all(...parameters);
      });
      return fast.accepted?fast.value:undefined;
    };
    // A large short-term cursor page can run hundreds of individual FTS probes
    // in the recent window. Try the existing bounded posting path first.
    const postingFirst=!!opts.cursor&&limit>=64&&where.includes(frequentPairPredicate)&&!hasSelectiveTerm;
    if(postingFirst){const page=readPostingPage();if(page)return page;}
    if(hasFrequentTerm&&offset===0&&canBoundFrequent){
      const cursorWhere=opts.cursor?'WHERE COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?)':'';
      const cursorArgs=opts.cursor?[opts.cursor.sortTime,opts.cursor.sortTime,opts.cursor.id]:[];
      if(!opts.listOnly){
        // Filter and sort metadata before loading the full bodies of the final page.
        const candidates=`SELECT e.id,ROW_NUMBER() OVER (ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC) page_order FROM recent CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=recent.id JOIN feeds f ON f.id=e.feed_id ${where.length?'WHERE '+where.join(' AND '):''} ${order}`;
        // Preserve SQLite's exact order without sorting large bodies in a temporary B-tree.
        const bounded=`WITH recent AS MATERIALIZED (SELECT e.id FROM entries e ${cursorWhere} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 200), selected AS MATERIALIZED (${candidates}), physical AS MATERIALIZED (SELECT selected.id,selected.page_order,m.rowid storage_rowid FROM selected CROSS JOIN entries m INDEXED BY entries_list_metadata ON m.id=selected.id ORDER BY m.rowid) ${select},physical.page_order _rivu_page_order FROM physical CROSS JOIN entries e ON e.rowid=physical.storage_rowid${metadataJoin} JOIN feeds f ON f.id=m.feed_id`;
        const page=db.prepare(bounded).all(...cursorArgs,...args,limit,0).sort((a,b)=>Number(a._rivu_page_order)-Number(b._rivu_page_order)).map(({_rivu_page_order,...row})=>row);
        if(page.length===limit)return page;
      }else{
        const key=opts.listOnly?'id':'rowid',index=opts.listOnly?' INDEXED BY entries_list_metadata':'';
        const bounded=`WITH recent AS MATERIALIZED (SELECT e.${key} FROM entries e ${cursorWhere} ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC LIMIT 200) ${select} FROM recent CROSS JOIN entries e${index} ON e.${key}=recent.${key}${metadataJoin} JOIN feeds f ON f.id=e.feed_id ${where.length?'WHERE '+where.join(' AND '):''} ${order}`;
        const page=db.prepare(bounded).all(...cursorArgs,...args,limit,0);
        if(page.length===limit)return page;
      }
    }
    if(!postingFirst){const page=readPostingPage();if(page)return page;}
    // Raw is:unread keeps muted articles. Only simple non-text predicates can
    // use this projection; starred/saved/tag/muted/blocked searches keep their
    // original fallback semantics.
    const rawSimple=new Set(['e.read=0',`NOT ${blocked}`,'e.feed_id=?','f.category_id=?','f.title LIKE ?',
      '(COALESCE(e.published_at,e.fetched_at)<=? AND (COALESCE(e.published_at,e.fetched_at)<? OR e.id<?))']);
    const rawSafe=fallbackWhere.every(part=>rawSimple.has(part)||/^(?:COALESCE\(e\.published_at,e\.fetched_at\)|substr\(COALESCE\(e\.published_at,e\.fetched_at\),1,10\))(?:>=|<)\?$/.test(part));
    if((!opts.view||opts.view==='all')&&where.includes('e.read=0')&&rawSafe){
      const ownsSnapshot=!db.isTransaction;if(ownsSnapshot)db.exec('BEGIN');
      try{
        const catalog=db.prepare('SELECT NOT EXISTS(SELECT 1 FROM rivu_source_entry_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL) valid').get() as {valid:number};
        const predicates=fallbackWhere.filter(part=>part!=='e.read=0'&&part!==`NOT ${blocked}`).map(part=>part
          .replace('f.category_id=?','r.feed_id IN (SELECT id FROM feeds WHERE category_id=?)')
          .replace('f.title LIKE ?','r.feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)')
          .replaceAll('substr(COALESCE(e.published_at,e.fetched_at),1,10)','r.sort_bucket')
          .replaceAll('COALESCE(e.published_at,e.fetched_at)','r.sort_time')
          .replaceAll('e.feed_id','r.feed_id').replaceAll('e.id','r.entry_id'));
        if(!catalog.valid)predicates.push('EXISTS(SELECT 1 FROM feeds f WHERE f.id=r.feed_id)');
        if(opts.cursor)predicates.push('r.sort_bucket<=substr(?,1,10)');
        const index=opts.feedId?'rivu_raw_unread_feed':'rivu_raw_unread_timeline';
        const selected=`SELECT r.entry_id id FROM rivu_raw_unread_entries r INDEXED BY ${index} ${predicates.length?'WHERE '+predicates.join(' AND '):''} ORDER BY r.sort_bucket DESC,r.sort_time DESC,r.entry_id DESC LIMIT ? OFFSET ?`;
        const page=`WITH selected AS MATERIALIZED (${selected}) ${select} FROM selected CROSS JOIN entries e${opts.listOnly?' INDEXED BY entries_list_metadata':''} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=e.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
        return db.prepare(page).all(...args,...(opts.cursor?[opts.cursor.sortTime]:[]),limit,offset);
      }finally{if(ownsSnapshot)db.exec('ROLLBACK');}
    }
    const projectionWhere=fallbackWhere.map(part=>{
      if(part===`NOT ${blocked}`)return opts.view==='unread'?'1':'v.blocked=0';
      if(part===blocked)return 'v.blocked=1';
      if(part==='e.read=0'&&opts.view==='unread')return 'v.visible=1';
      if(part===`NOT ${muted}`&&opts.view==='unread')return '1';
      return part.replaceAll('COALESCE(e.published_at,e.fetched_at)','v.sort_time').replace(/\be\.id\b/g,'v.entry_id').replace(/\be\.feed_id\b/g,'v.feed_id').replace('f.category_id=?','v.feed_id IN (SELECT id FROM feeds WHERE category_id=?)').replace('f.title LIKE ?','v.feed_id IN (SELECT id FROM feeds WHERE title LIKE ?)');
    });
    if(!opts.feedId&&projectionQuerySafe&&projectionWhere.every(part=>!/(?:\be|\bf)\./.test(part))&&!(opts.view==='unread'&&fallbackWhere.includes(blocked))&&(offset>0||opts.cursor||opts.feedId||opts.categoryId||opts.query)&&['all','unread','blocked','summary','images','audio','video'].includes(opts.view||'all')){
      // The maintained projection orders eligible IDs without touching skipped
      // article bodies or rebuilding large block/mute sets on every page.
      // Counts retain missing-source keys as well: deleting a feed with FK checks
      // disabled must not make its orphan articles consume pagination slots.
      const cleanFeed='NOT EXISTS (SELECT 1 FROM rivu_source_entry_counts c LEFT JOIN feeds f ON f.id=c.feed_id WHERE f.id IS NULL)';
      // Keep the catalog proof and selected page in one snapshot. A per-row CASE
      // otherwise prevents SQLite's LIMIT/OFFSET index-skip optimization.
      const ownsSnapshot=!db.isTransaction;
      if(ownsSnapshot)db.exec('BEGIN');
      try{
      const catalog=db.prepare(`SELECT ${cleanFeed} valid`).get() as {valid:number};
      const validFeed=catalog.valid?'1':'EXISTS(SELECT 1 FROM feeds f WHERE f.id=v.feed_id)';
      const candidateWhere=[...projectionWhere];
      let pageOffset=offset;
      const bucketArgs:(string|Uint8Array)[]=[...bucketDateArgs];
      // Whole-day prefix predicates are equivalent to their original time bounds
      // and let the ordered projection seek past excluded days on the first page.
      candidateWhere.push(...bucketDateWhere.map(part=>'v.'+part));
      if(opts.cursor){candidateWhere.push('v.sort_bucket<=substr(?,1,10)');bucketArgs.push(opts.cursor.sortTime);}
      if(offset>0&&catalog.valid&&!opts.feedId&&!opts.tagId&&bucketCountQuerySafe&&['all','unread','blocked'].includes(opts.view||'all')){
        const count=opts.view==='unread'?'visible_count':opts.view==='blocked'?'blocked_count':'entry_count-blocked_count';
        let skipped=0,found=false;
        let categoryOnly=!!opts.categoryId&&bucketSourceWhere.length===1,wholeScope=false;
        if(bucketSourceWhere.length&&!categoryOnly){
          // Prove universal source-name filters in the same snapshot. The final
          // page still evaluates every original predicate; only its count source
          // can collapse to the already maintained category/global buckets.
          const sourcePredicates=bucketSourceWhere.map(part=>part.replace(/\bfeed_id\b/g,'f.id'));
          const scope=opts.categoryId?'f.category_id=?':'1';
          const proof=db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM feeds f WHERE ${scope} AND NOT (${sourcePredicates.join(' AND ')})) valid`).get(...(opts.categoryId?[opts.categoryId,...bucketSourceArgs]:bucketSourceArgs)) as {valid:number};
          wholeScope=!!proof.valid;categoryOnly=wholeScope&&!!opts.categoryId;
        }
        let sourceIndex='';
        if(bucketSourceWhere.length&&!categoryOnly&&!wholeScope){
          // The secondary feed index serves metadata edits. For wide history
          // scans it causes random lookups and a temporary GROUP BY; force the
          // clustered bucket order instead, without assuming an autoindex name.
          const primary=db.prepare("SELECT name FROM pragma_index_list('rivu_feed_timeline_bucket_counts') WHERE origin='pk'").get() as {name:string}|undefined;
          if(!primary)throw Error('来源时间分桶主键缺失');
          sourceIndex=` INDEXED BY "${primary.name.replaceAll('"','""')}"`;
        }
        const buckets=categoryOnly?db.prepare(`SELECT sort_bucket,${count} n FROM rivu_category_timeline_bucket_counts WHERE ${['category_id=?',`${count}>0`,...bucketDateWhere].join(' AND ')} ORDER BY sort_bucket DESC`).iterate(opts.categoryId!,...bucketDateArgs):bucketSourceWhere.length&&!wholeScope?db.prepare(`SELECT sort_bucket,SUM(${count}) n FROM rivu_feed_timeline_bucket_counts${sourceIndex} WHERE ${[...bucketSourceWhere,...bucketDateWhere].join(' AND ')} GROUP BY sort_bucket HAVING SUM(${count})>0 ORDER BY sort_bucket DESC`).iterate(...bucketSourceArgs,...bucketDateArgs):db.prepare(`SELECT sort_bucket,${count} n FROM rivu_timeline_bucket_counts WHERE ${[`${count}>0`,...bucketDateWhere].join(' AND ')} ORDER BY sort_bucket DESC`).iterate(...bucketDateArgs);
        for(const row of buckets){
          const size=Number(row.n);
          if(offset<skipped+size){
            // Include older buckets so a page crossing a boundary is still full.
            candidateWhere.push('v.sort_bucket<=?');bucketArgs.push(row.sort_bucket as string|Uint8Array);
            pageOffset=offset-skipped;found=true;break;
          }
          skipped+=size;
        }
        if(!found)return [];
      }
      const scoped=projectionWhere.some(part=>part.includes('v.feed_id IN'));const candidateIndex=opts.view==='unread'?(scoped?'rivu_visibility_unread_scoped':'rivu_visibility_unread'):(scoped?'rivu_visibility_scoped':'rivu_visibility_timeline');
      const candidates=`SELECT v.entry_id id,v.sort_time FROM rivu_entry_visibility v INDEXED BY ${candidateIndex} WHERE ${[validFeed,...candidateWhere].join(' AND ')} ORDER BY v.sort_bucket DESC,v.sort_time DESC,v.entry_id DESC LIMIT ? OFFSET ?`;
      const proof='',pageArgs=[...args,...bucketArgs,limit,pageOffset];
      if(!opts.listOnly){
        const page=`WITH ${proof}selected AS MATERIALIZED (${candidates}), ranked AS MATERIALIZED (SELECT id,ROW_NUMBER() OVER (ORDER BY sort_time DESC,id DESC) page_order FROM selected), physical AS MATERIALIZED (SELECT ranked.id,ranked.page_order,m.rowid storage_rowid FROM ranked CROSS JOIN entries m INDEXED BY entries_list_metadata ON m.id=ranked.id ORDER BY m.rowid) ${select},physical.page_order _rivu_page_order FROM physical CROSS JOIN entries e ON e.rowid=physical.storage_rowid${metadataJoin} JOIN feeds f ON f.id=m.feed_id`;
        return db.prepare(page).all(...pageArgs).sort((a,b)=>Number(a._rivu_page_order)-Number(b._rivu_page_order)).map(({_rivu_page_order,...row})=>row);
      }
      const index=opts.listOnly?' INDEXED BY entries_list_metadata':'';
      const page=`WITH ${proof}selected AS MATERIALIZED (${candidates}) ${select} FROM selected CROSS JOIN entries e${index} ON e.id=selected.id${metadataJoin} JOIN feeds f ON f.id=${opts.listOnly?'e':'m'}.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
      return db.prepare(page).all(...pageArgs);
      }finally{if(ownsSnapshot)db.exec('ROLLBACK');}
    }
    if(opts.listOnly){
      const candidates=`SELECT e.id FROM entries e JOIN feeds f ON f.id=e.feed_id ${fallbackWhere.length?'WHERE '+fallbackWhere.join(' AND '):''} ${order}`;
      const page=`WITH selected AS MATERIALIZED (${candidates}) ${select} FROM selected CROSS JOIN entries e INDEXED BY entries_list_metadata ON e.id=selected.id JOIN feeds f ON f.id=e.feed_id ORDER BY COALESCE(e.published_at,e.fetched_at) DESC,e.id DESC`;
      return db.prepare(page).all(...args,limit,offset);
    }
    const sql=`${select} FROM entries e${metadataJoin} JOIN feeds f ON f.id=e.feed_id ${fallbackWhere.length?'WHERE '+fallbackWhere.join(' AND '):''} ${order}`;
    return db.prepare(sql).all(...args,limit,offset);
  }
