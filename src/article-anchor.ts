// The caller must supply the SHA-256 of the exact source body.
import {parseArticleAnchor,type ArticleAnchor} from '../shared/reading-anchor';
import {articleSourcePosition,articleSourceChild} from './article-layout-groups';
export {parseArticleAnchor,type ArticleAnchor} from '../shared/reading-anchor';
const htmlNamespace='http://www.w3.org/1999/xhtml';

// Bound inspection and allocation even for a giant text node or an empty subtree.
function edgeText(root:Element,reverse:boolean):string {
  let node:Node|null=reverse?root.lastChild:root.firstChild,result='',visited=0;
  while(node&&visited++<512&&result.length<96){
    if(node.nodeType===3){const text=node.nodeValue||'',remaining=96-result.length;result=reverse?text.slice(-remaining)+result:result+text.slice(0,remaining);}
    const child=reverse?node.lastChild:node.firstChild;
    if(child){node=child;continue;}
    while(node&&node!==root&&!(reverse?node.previousSibling:node.nextSibling))node=node.parentNode;
    if(!node||node===root)break;
    node=reverse?node.previousSibling:node.nextSibling;
  }
  return result;
}

export function createArticleAnchor(root:HTMLElement,node:HTMLElement,revision:string,offset:number):ArticleAnchor|null {
  if(node===root||!root.contains(node)||node.namespaceURI!==htmlNamespace)return null;
  const path:number[]=[];let current:Element|null=node,steps=0;
  while(current&&current!==root){
    if(path.length>=32)return null;
    const position=articleSourcePosition(current,65535-steps);if(!position)return null;
    steps+=position.steps;path.unshift(position.index);current=position.parent;
  }
  if(current!==root)return null;
  return parseArticleAnchor({version:1,revision,path,tag:node.tagName,head:edgeText(node,false),tail:edgeText(node,true),offset});
}

export function resolveArticleAnchor(root:HTMLElement,value:unknown,revision:string):{node:HTMLElement;offset:number}|null {
  const anchor=parseArticleAnchor(value);if(!anchor||anchor.revision!==revision)return null;
  let node:Element=root;
  for(const index of anchor.path){const child=articleSourceChild(node,index);if(!child)return null;node=child;}
  if(node.namespaceURI!==htmlNamespace||node.tagName!==anchor.tag||edgeText(node,false)!==anchor.head||edgeText(node,true)!==anchor.tail)return null;
  return {node:node as HTMLElement,offset:anchor.offset};
}
