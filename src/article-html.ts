import DOMPurify from 'dompurify';
import {articleHtmlPolicy} from '../shared/article-policy';
import {renderPlainParagraphFragment} from './plain-paragraph-html';

type Options={baseUrl?:string|null}&({kind:'reader'}|{kind:'archive';assets:readonly {id:string;kind:string;url:string}[]});

// Source HTML is read-only content. App styling and loading markers belong to the renderer.
function sanitizedArticleRoot(source:string,options:Options):HTMLElement|null {
  // Rewrite the detached sanitized DOM directly; serializing and reparsing it
  // first duplicates HTML parsing and discards leading whitespace.
  const sanitized=DOMPurify.sanitize(source,{...articleHtmlPolicy(),RETURN_DOM:true});
  if(!sanitized||sanitized.nodeType!==1)return null;
  const root=sanitized as HTMLElement;
  const assets=options.kind==='archive'?new Map(options.assets.filter(asset=>asset.kind==='image').map(asset=>[asset.url,asset.id])):null;
  for(const element of root.querySelectorAll('[src],[href]'))for(const attribute of ['src','href']){
    const value=element.getAttribute(attribute);element.removeAttribute(attribute);if(!value?.trim())continue;
    let url:URL;try{url=new URL(value,options.baseUrl||undefined);}catch{element.removeAttribute(attribute);continue;}
    if(url.protocol!=='http:'&&url.protocol!=='https:'){element.removeAttribute(attribute);continue;}
    if(attribute==='href'){element.setAttribute(attribute,url.href);continue;}
    element.removeAttribute(attribute);
    if(element.tagName!=='IMG')continue;
    if(options.kind==='reader')element.setAttribute('data-rivu-url',url.href);
    else{const id=assets?.get(url.href);if(id)element.setAttribute('data-archive-asset',id);}
  }
  return root;
}

// Candidate direct-DOM path: consumers can clone the fragment for repeated
// mounts without serializing or reparsing sanitized HTML.
export function renderArticleFragment(source:string,options:Options):DocumentFragment|null {
  if(options.kind==='reader'){
    const plain=renderPlainParagraphFragment(source);if(plain)return plain;
  }
  const root=sanitizedArticleRoot(source,options);if(!root)return null;
  const fragment=root.ownerDocument.createDocumentFragment();
  while(root.firstChild)fragment.appendChild(root.firstChild);
  return fragment;
}

export function renderArticleHtml(source:string,options:Options):string {
  const root=sanitizedArticleRoot(source,options);if(!root)return '';
  // The final innerHTML insertion consumes a leading LF in pre/listing. Pad
  // that LF so the text in the sanitized DOM survives the insertion intact.
  for(const element of root.querySelectorAll('pre,listing'))if(element.firstChild?.nodeType===3&&element.firstChild.textContent?.startsWith('\n'))element.firstChild.textContent='\n'+element.firstChild.textContent;
  return root.innerHTML;
}
