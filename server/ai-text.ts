import { JSDOM } from 'jsdom';

export function aiPlainText(html:string){
  const page=new JSDOM(html);
  try{
  page.window.document.querySelectorAll('script,style,noscript').forEach(node=>node.remove());
  page.window.document.querySelectorAll('p,div,li,br,h1,h2,h3,blockquote').forEach(node=>node.append('\n'));
  const text=page.window.document.body.textContent?.replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim()||'';
  return text;
  }finally{page.window.close();}
}
