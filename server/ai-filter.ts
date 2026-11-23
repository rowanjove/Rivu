export type FilterSuggestion={decision:'keep'|'mute'|'block';reason:string};
export function parseFilterSuggestion(content:string):FilterSuggestion{
  const invalid=()=>Object.assign(Error('模型过滤建议格式无效；未改变文章状态'),{statusCode:502});
  if(content.length>2048)throw invalid();
  let value:unknown;
  try{value=JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i,'$1'));}catch{throw invalid();}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['decision','reason'].includes(key)))throw invalid();
  const raw=value as Record<string,unknown>;
  if(typeof raw.decision!=='string'||!['keep','mute','block'].includes(raw.decision)||typeof raw.reason!=='string'||!raw.reason.trim()||raw.reason.trim().length>400)throw invalid();
  return {decision:raw.decision as FilterSuggestion['decision'],reason:raw.reason.trim()};
}
