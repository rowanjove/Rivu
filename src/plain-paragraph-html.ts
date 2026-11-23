// Recognize only a complete concatenation of attribute-free HTML paragraphs.
// Every raw '<' must begin the exact next closing/opening paragraph token.
// Entities remain text after HTML parsing; they cannot introduce markup tokens.
export function isPlainParagraphHtml(source:string):boolean {
  if(!source.length)return false;
  let offset=0;
  while(offset<source.length){
    if(!source.startsWith('<p>',offset))return false;
    const close=source.indexOf('<',offset+3);
    if(close<0||!source.startsWith('</p>',close))return false;
    offset=close+4;
  }
  return true;
}

export function renderPlainParagraphFragment(source:string):DocumentFragment|null {
  if(!isPlainParagraphHtml(source)||typeof window==='undefined')return null;
  try{
    const body=new window.DOMParser().parseFromString(source,'text/html').body;
    const fragment=body.ownerDocument.createDocumentFragment();
    while(body.firstChild)fragment.appendChild(body.firstChild);
    return fragment;
  }catch{
    // In particular, a stricter Trusted Types policy can require the existing
    // DOMPurify path to supply its policy-owned TrustedHTML object.
    return null;
  }
}
