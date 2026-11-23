const asciiFold=(value:string)=>value.replace(/[A-Z]/g,char=>char.toLowerCase());

export function pairTerm(value:string){
  return `g${Buffer.from(asciiFold(value),'utf8').toString('hex')}`;
}

export function pairTokens(...values:unknown[]){
  const raw=new Set<string>();
  for(const value of values){
    if(typeof value!=='string'||!value)continue;
    const chars=Array.from(value);
    for(const char of chars)raw.add(char);
    for(let index=0;index+1<chars.length;index++)raw.add(chars[index]+chars[index+1]);
  }
  return [...new Set([...raw].map(pairTerm))].join(' ');
}
