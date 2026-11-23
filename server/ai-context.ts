// Provider-neutral conservative estimate: one UTF-8 byte per token, plus framing.
// This is a local budgeting policy, not the provider's tokenizer count.
export type ContextMessage={role:'system'|'user'|'assistant';content:string};
export const textCost=(text:string)=>Buffer.byteLength(text,'utf8');
export const messagesCost=(messages:ContextMessage[])=>256+messages.reduce((sum,message)=>sum+16+textCost(message.content),0);
export type AITextResult={body:string;paragraphs:string[]};
export function excerptParagraphs(body:string):string[]{
  const paragraphs:string[]=[];let start=0;
  while(start<body.length&&paragraphs.length<5){
    const newline=body.indexOf('\n',start),end=newline<0?body.length:newline,paragraph=body.slice(start,end).trim();
    if(paragraph)paragraphs.push(paragraph.slice(0,800));
    if(newline<0)break;start=newline+1;
  }
  return paragraphs;
}
export function fitText(text:string,budget:number){
  if(budget<=0)return '';
  // UTF-8 never costs less than one byte per UTF-16 code unit. A fitting
  // prefix cannot extend past this bound, regardless of the original length.
  const prefix=text.slice(0,Math.min(text.length,Math.floor(budget)));
  let low=prefix.length;
  if(textCost(prefix)>budget){let high=prefix.length;low=0;while(low<high){const mid=Math.ceil((low+high)/2);if(textCost(prefix.slice(0,mid))<=budget)low=mid;else high=mid-1;}}
  if(low>0&&(low<text.length)&&/[\uD800-\uDBFF]/.test(prefix[low-1]))low--;
  return prefix.slice(0,low);
}
