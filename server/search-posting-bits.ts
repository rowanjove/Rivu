import type {DatabaseSync} from 'node:sqlite';

const MAX_TERMS=8,MAX_SPAN=4_194_304,MAX_PACKED_CHARS=8*1024*1024,MAX_POSTINGS=1_000_000;
type Slot={bits:Uint8Array;lo:number;hi:number};
type ByteMembership={bytes:Uint8Array;lo:number;hi:number;count:number};
const states=new WeakMap<DatabaseSync,{active:boolean;slots:(Slot|undefined)[]}>();
export type SearchPosting={sql:string;args:readonly (string|number|bigint|null)[]};
export type PostingBitsResult<T>={accepted:true;value:T;packedCharacters:number;bitmapBytes:number}|{accepted:false;reason:string};

// SQL fragments are trusted application-owned posting queries, never user SQL.
// Each must return an integer column named entry_rowid. No TEMP-mode changes:
// bounded strings and bitmaps live only during the consumed synchronous page.
export function withSearchPostingBits<T>(db:DatabaseSync,postings:readonly SearchPosting[],consume:(names:readonly string[],counts:readonly number[],packed:readonly string[],byteMembership:()=>ByteMembership|null,intersectRows:()=>number[])=>T):PostingBitsResult<T>{
 if(!db.isTransaction)throw Error('搜索位图需要读取快照');
 if(!postings.length||postings.length>MAX_TERMS)return {accepted:false,reason:'term-budget'};
 let state=states.get(db);
 if(state?.active)return {accepted:false,reason:'nested-search'};
 const rangeStatement=db.prepare('SELECT (SELECT rowid FROM entries ORDER BY rowid LIMIT 1) lo,(SELECT rowid FROM entries ORDER BY rowid DESC LIMIT 1) hi');
 rangeStatement.setReadBigInts(true);const range=rangeStatement.get() as {lo:bigint|null;hi:bigint|null};
 if(range.lo!==null&&(range.lo<=0n||range.hi!>BigInt(Number.MAX_SAFE_INTEGER)||range.hi!-range.lo+1n>BigInt(MAX_SPAN)))return {accepted:false,reason:'rowid-budget'};
 if(!state){
  state={active:false,slots:[]};const captured=state;
  for(let index=0;index<MAX_TERMS;index++)db.function(`rivu_search_bits_${index}`,{deterministic:true},value=>{
   const slot=captured.slots[index];
   if(!slot||typeof value!=='number'||!Number.isSafeInteger(value)||value<slot.lo||value>slot.hi)return 0;
   const offset=value-slot.lo;return slot.bits[offset>>3]&(1<<(offset&7))?1:0;
  });
  states.set(db,state);
 }
 state.active=true;
 try{
  const lo=Number(range.lo??0n),hi=Number(range.hi??-1n),span=Math.max(0,hi-lo+1),names:string[]=[];
  let packedCharacters=0,bitmapBytes=0;const counts:number[]=[],payloads:string[]=[];
  for(const [index,posting]of postings.entries()){
   const remaining=MAX_PACKED_CHARS-packedCharacters,charsPerRow=Math.max(1,String(hi).length)+1;
   const cap=Math.min(MAX_POSTINGS,Math.floor(remaining/charsPerRow));
   if(cap<1)return {accepted:false,reason:'posting-budget'};
   const packed=db.prepare(`SELECT group_concat(entry_rowid,',') payload,count(*) n FROM (SELECT entry_rowid FROM (${posting.sql}) WHERE entry_rowid>=? AND entry_rowid<=? LIMIT ?)`).get(...posting.args,lo,hi,cap+1) as {payload:string|null;n:number};
   if(packed.n>cap)return {accepted:false,reason:'posting-budget'};
   counts.push(packed.n);
   const payload=packed.payload??'';packedCharacters+=payload.length;
   payloads.push(payload);
   if(packedCharacters>MAX_PACKED_CHARS)return {accepted:false,reason:'posting-budget'};
   const bits=new Uint8Array(Math.ceil(span/8));let value=0;
   if(payload)for(let cursor=0;cursor<=payload.length;cursor++){
    const code=cursor===payload.length?44:payload.charCodeAt(cursor);
    if(code===44){
     if(!Number.isSafeInteger(value)||value<lo||value>hi)throw Error('搜索posting行号无效');
     const offset=value-lo;bits[offset>>3]|=1<<(offset&7);value=0;
    }else{
     if(code<48||code>57)throw Error('搜索posting行号无效');value=value*10+code-48;
    }
   }
   state.slots[index]={bits,lo,hi};bitmapBytes+=bits.byteLength;names.push(`rivu_search_bits_${index}`);
  }
  const slot=state.slots[0];
  const byteMembership=()=>{
   if(postings.length!==1||!slot||state.slots[0]!==slot||span>1024*1024)return null;
   const bytes=new Uint8Array(span);let count=0;
   for(let offset=0;offset<span;offset++){const member=(slot.bits[offset>>3]>>(offset&7))&1;bytes[offset]=member;count+=member;}
   return {bytes,lo,hi,count};
  };
  const intersectRows=()=>{
   if(!slot||state.slots[0]!==slot)return [];
   const rows:number[]=[];
   for(let byte=0;byte<slot.bits.length;byte++){
    let mask=slot.bits[byte];
    for(let index=1;mask&&index<postings.length;index++)mask&=state.slots[index]!.bits[byte];
    while(mask){const bit=mask&-mask;rows.push(lo+byte*8+31-Math.clz32(bit));mask^=bit;}
   }
   return rows;
  };
  const value=consume(names,counts,payloads,byteMembership,intersectRows);
  if(value&&(typeof value==='object'||typeof value==='function')&&typeof (value as {then?:unknown}).then==='function'){
   if(value instanceof Promise)void value.catch(()=>{});
   throw Error('搜索位图必须同步消费');
  }
  return {accepted:true,value,packedCharacters,bitmapBytes};
 }finally{state.slots.length=0;state.active=false;}
}
