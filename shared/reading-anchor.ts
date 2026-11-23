// Persisted anchor wire format. No DOM, filesystem or database dependencies.
export type ArticleAnchor={version:1;revision:string;path:number[];tag:string;head:string;tail:string;offset:number};

export function parseArticleAnchor(value:unknown):ArticleAnchor|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!=='head,offset,path,revision,tag,tail,version')return null;
  if(row.version!==1||typeof row.revision!=='string'||!/^[a-f0-9]{64}$/.test(row.revision))return null;
  if(!Array.isArray(row.path)||row.path.length<1||row.path.length>32||Array.from(row.path).some(i=>!Number.isInteger(i)||i<0||i>65535))return null;
  if(typeof row.tag!=='string'||!/^[A-Z][A-Z0-9]{0,31}$/.test(row.tag))return null;
  if(typeof row.head!=='string'||row.head.length>96||typeof row.tail!=='string'||row.tail.length>96)return null;
  if(typeof row.offset!=='number'||!Number.isFinite(row.offset)||Math.abs(row.offset)>1e7)return null;
  return {version:1,revision:row.revision,path:[...row.path] as number[],tag:row.tag,head:row.head,tail:row.tail,offset:row.offset};
}

