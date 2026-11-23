export type TagSuggestion = {name:string;reason:string};

export function parseTagSuggestions(content:string):TagSuggestion[] {
  const invalid=()=>Object.assign(Error('模型标签结果格式无效，请重新生成；未写入任何标签'),{statusCode:502});
  if(content.length>4096)throw invalid();
  let value:unknown;
  try { value=JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1')); } catch { throw invalid(); }
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='tags'))throw invalid();
  const tags=(value as {tags?:unknown}).tags;
  if(!Array.isArray(tags)||tags.length>8)throw invalid();
  const result:TagSuggestion[]=[],names=new Set<string>();
  for(const tag of tags){
    if(!tag||typeof tag!=='object'||Array.isArray(tag)||Object.keys(tag).some(key=>!['name','reason'].includes(key)))throw invalid();
    if(typeof tag.name!=='string'||typeof tag.reason!=='string')throw invalid();
    const name=tag.name.trim(),reason=tag.reason.trim();
    if(!name||name.length>40||!reason||reason.length>240||/[\u0000-\u001f\u007f]/.test(name)||names.has(name))throw invalid();
    names.add(name);result.push({name,reason});
  }
  return result;
}
