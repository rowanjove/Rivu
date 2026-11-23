function validDate(value:unknown){
  if(value===null||value===undefined||value==='')return null;
  if(!(typeof value==='string'||typeof value==='number'||value instanceof Date))return null;
  const date=value instanceof Date?new Date(value.getTime()):new Date(value);
  return Number.isFinite(date.getTime())?date:null;
}
export function formatShortDate(value:unknown,timeZone?:string){
  const date=validDate(value);if(!date)return '未知时间';
  return new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',...(timeZone?{timeZone}:{})}).format(date);
}
export function formatFullDate(value:unknown){
  const date=validDate(value);return date?date.toLocaleString('zh-CN'):'未知时间';
}
