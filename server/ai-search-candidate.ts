import type {DatabaseSync} from 'node:sqlite';

const COMMON=1000,MAX_PREFIX_ROWS=65536;
// Only a candidate selector. The caller must retain the original full-content
// LIKE predicate, summary type check and article MATCH expression.
export function summaryCandidateMatch(db:DatabaseSync,term:string,fullMatch:string,frequent:boolean){
 if(!frequent||!db.isTransaction||typeof term!=='string'||!/^[\p{L}\p{N}]{4,32}$/u.test(term))return fullMatch;
 const countTo=(match:string,limit:number)=>(db.prepare('SELECT count(*) n FROM (SELECT rowid FROM ai_result_fts WHERE ai_result_fts MATCH ? LIMIT ?)').get(match,limit) as {n:number}).n;
 const common=countTo(fullMatch,COMMON+1);if(common<=COMMON)return fullMatch;
 const prefix=`"${Array.from(term).slice(0,3).join('')}"`,candidates=countTo(prefix,MAX_PREFIX_ROWS+1);
 if(candidates<common||candidates>MAX_PREFIX_ROWS)return fullMatch;
 // Confirm at least half of the candidate population matches the full phrase.
 // Stop as soon as this proof succeeds; never enumerate an unbounded posting.
 const required=Math.ceil(candidates/2);
 if(required>common&&countTo(fullMatch,required)<required)return fullMatch;
 return prefix;
}
