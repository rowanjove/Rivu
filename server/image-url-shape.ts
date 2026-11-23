export function resolveArticleImageUrl(value:string|undefined,base:string):string|undefined{
  if(!value)return;
  try{
    const url=new URL(value,base||undefined);
    if((url.protocol==='http:'||url.protocol==='https:')&&!url.username&&!url.password)return url.href;
  }catch{/* The parser ignores invalid image URLs. */}
}

// Only the exact one-image form can avoid the HTML parser. In particular,
// comments, templates, entities, namespaces and duplicate attributes fall back.
export function simpleArticleImageUrl(source:string,base:string):string|undefined{
  if(typeof source!=='string'||typeof base!=='string'||source.length>1024||base.length>8192)return;
  let html=source.trim();
  if(html.startsWith('<p>')&&html.endsWith('</p>'))html=html.slice(3,-4).trim();
  const match=/^<img src="([^"<>&]+)"(?: alt="[^"<>&\u0000]*")? ?\/?>$/u.exec(html);
  if(!match||/[^\x21-\x7e]/.test(match[1]))return;
  return resolveArticleImageUrl(match[1],base);
}
