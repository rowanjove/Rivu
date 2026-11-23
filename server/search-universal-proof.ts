import type {DatabaseSync} from 'node:sqlite';

// Unique integer postings covering the entire article rowid interval prove
// coverage of every article. Equal total counts alone would not prove this.
// Keep this proof and the eventual page in the same read snapshot.
export function universalSearchProof(db:DatabaseSync){
 if(!db.isTransaction)throw Error('搜索覆盖证明需要读取快照');
 let range:{lo:bigint|null;hi:bigint|null}|undefined;
 return (table:'entry_fts'|'entry_pair_fts',match:string)=>{
  if(!range){
   const statement=db.prepare('SELECT (SELECT rowid FROM entries ORDER BY rowid LIMIT 1) lo,(SELECT rowid FROM entries ORDER BY rowid DESC LIMIT 1) hi');
   statement.setReadBigInts(true);range=statement.get() as {lo:bigint|null;hi:bigint|null};
  }
  if(range.lo===null||range.hi===null)return true;
  // Both endpoints are real articles. A missing endpoint disproves universal
  // coverage without counting a potentially large posting list.
  const endpoint=db.prepare(`SELECT 1 FROM ${table} WHERE ${table} MATCH ? AND rowid=?`);
  if(!endpoint.get(match,range.lo)||!endpoint.get(match,range.hi))return false;
  const statement=db.prepare(`SELECT count(*) n FROM ${table} WHERE ${table} MATCH ? AND rowid>=? AND rowid<=?`);
  statement.setReadBigInts(true);const row=statement.get(match,range.lo,range.hi) as {n:bigint};
  return row.n===range.hi-range.lo+1n;
 };
}
