import {yieldBackgroundTask} from './background-task';

type State={root:HTMLElement;nodes:HTMLElement[];positions:WeakMap<Element,number>;groups:HTMLElement[];retired:boolean;retire:()=>void};
const roots=new WeakMap<Element,State>();
const wrappers=new WeakMap<Element,State>();
const htmlNamespace='http://www.w3.org/1999/xhtml';

export function isArticleLayoutGroup(node:Element):boolean{return wrappers.has(node);}

export function articleSourceHit(root:HTMLElement,hit:HTMLElement,y:number):HTMLElement|null {
  const state=wrappers.get(hit);if(!state)return hit;
  if(state.root!==root||hit.parentElement!==root||!Number.isFinite(y))return null;
  let best:HTMLElement|null=null,distance=Infinity;
  for(let i=0;i<Math.min(64,hit.children.length);i++){
    const child=hit.children.item(i) as HTMLElement;if(!state.positions.has(child))continue;
    const rect=child.getBoundingClientRect(),delta=y<rect.top?rect.top-y:y>rect.bottom?y-rect.bottom:0;
    if(delta<distance){best=child;distance=delta;if(delta===0)break;}
  }
  return best;
}

// Runtime wrappers are never source path components. Only this private registry,
// not a source-controlled attribute/class, can make an element transparent.
export function articleSourcePosition(node:Element,budget:number):{parent:Element;index:number;steps:number}|null {
  if(wrappers.has(node))return null;
  let parent=node.parentElement;if(!parent)return null;
  const wrapperState=wrappers.get(parent);
  if(wrapperState){if(parent.parentElement!==wrapperState.root)return null;parent=wrapperState.root;}
  const state=roots.get(parent);
  if(state){const index=state.positions.get(node);return index!==undefined&&index<=budget?{parent,index,steps:index}:null;}
  let index=0,sibling=node.previousElementSibling;
  while(sibling){if(++index>budget)return null;sibling=sibling.previousElementSibling;}
  return {parent,index,steps:index};
}

export function articleSourceChild(parent:Element,index:number):Element|null {
  if(!Number.isSafeInteger(index)||index<0||index>65535)return null;
  const state=roots.get(parent);
  if(!state)return parent.children.item(index);
  const child=state.nodes[index];if(!child)return null;
  const position=articleSourcePosition(child,65535);
  return position?.parent===parent&&position.index===index?child:null;
}

// Only plain paragraphs can be grouped. Oversized paragraphs keep the original
// renderer; never combine a giant native layout operation with its neighbors.
export function createArticleLayoutGroups(root:HTMLElement,options:{groupSize?:number}={}){
  roots.get(root)?.retire();
  const size=options.groupSize??32;
  if(!Number.isInteger(size)||size<2||size>64)throw new RangeError('Invalid article group size');
  const nodes=[...root.children] as HTMLElement[];
  if(nodes.length<16||root.childNodes.length!==nodes.length||nodes.some(node=>node.namespaceURI!==htmlNamespace||node.tagName!=='P'||node.attributes.length||[...node.childNodes].some(child=>child.nodeType!==3)))return null;
  const lengths=nodes.map(node=>[...node.childNodes].reduce((sum,child)=>sum+(child as Text).length,0));
  if(lengths.some(length=>length>32768))return null;
  const positions=new WeakMap<Element,number>();nodes.forEach((node,index)=>positions.set(node,index));
  const state:State={root,nodes,positions,groups:[],retired:false,retire:()=>{}};
  const activeSelection=()=>{
    const selection=root.ownerDocument.defaultView?.getSelection();
    return selection&&!selection.isCollapsed&&!!(selection.anchorNode&&root.contains(selection.anchorNode)||selection.focusNode&&root.contains(selection.focusNode));
  };
  const preserveSelection=()=>{
    const selection=root.ownerDocument.defaultView?.getSelection();
    if(!selection?.anchorNode||!selection.focusNode||!root.contains(selection.anchorNode)&&!root.contains(selection.focusNode))return ()=>{};
    type Boundary={node:Node;offset:number;sourceOffset?:number};
    const boundary=(node:Node,offset:number):Boundary|null=>{
      if(node===root||wrappers.get(node as Element)===state){
        const child=node.childNodes.item(offset);
        if(child){const first=wrappers.get(child as Element)===state?child.firstChild:child;const index=first?positions.get(first as Element):undefined;return index!==undefined?{node:root,offset:0,sourceOffset:index}:null;}
        if(node===root)return {node:root,offset:0,sourceOffset:nodes.length};
        const last=node.lastChild,index=last&&positions.get(last as Element);return index!==undefined&&index!==null?{node:root,offset:0,sourceOffset:index+1}:null;
      }
      if(root.contains(node)){
        const element=node.nodeType===3?node.parentElement:node as Element;
        if(!element||!positions.has(element))return null;
      }
      return {node,offset};
    };
    const anchor=boundary(selection.anchorNode,selection.anchorOffset),focus=boundary(selection.focusNode,selection.focusOffset);
    return ()=>{
      if(!anchor||!focus||root.children.length!==nodes.length||nodes.some((node,index)=>root.children.item(index)!==node)||!anchor.node.isConnected||!focus.node.isConnected)return;
      selection.setBaseAndExtent(anchor.node,anchor.sourceOffset??anchor.offset,focus.node,focus.sourceOffset??focus.offset);
    };
  };
  const unwrap=(group:HTMLElement)=>{
    if(wrappers.get(group)!==state)return;
    // A replacement root may already exist. Only these exact owned wrappers
    // are touched; no query for new nodes or marker attributes is performed.
    group.replaceWith(...group.childNodes);wrappers.delete(group);
  };
  const retire=()=>{
    if(state.retired)return;state.retired=true;
    const restoreSelection=preserveSelection();
    for(const group of state.groups)unwrap(group);
    if(roots.get(root)===state)roots.delete(root);
    restoreSelection();
  };
  state.retire=retire;roots.set(root,state);
  try{
    for(let offset=0;offset<nodes.length;){
      let end=offset,chars=0;
      while(end<nodes.length&&end-offset<size&&chars+lengths[end]<=65536){chars+=lengths[end];end++;}
      const children=nodes.slice(offset,end),group=root.ownerDocument.createElement('div');offset=end;
      group.style.contentVisibility='auto';group.style.containIntrinsicSize=`auto ${children.length*100}px`;
      wrappers.set(group,state);state.groups.push(group);root.insertBefore(group,children[0]);group.append(...children);
    }
  }catch(error){retire();throw error;}
  let started=false;
  const run=async(options:{signal:AbortSignal;yieldTask?:()=>Promise<void>;onBatch?:(count:number)=>void})=>{
    if(started)throw Error('Article group layout already started');started=true;
    const schedule=options.yieldTask||(()=>yieldBackgroundTask(options.signal));
    const current=()=>!state.retired&&!options.signal.aborted&&roots.get(root)===state&&root.isConnected;
    const abort=()=>retire();options.signal.addEventListener('abort',abort,{once:true});let batches=0;
    try{
      if(!current())return {completed:false,batches};
      await schedule();
      for(const group of state.groups){
        if(!current()||group.parentElement!==root)return {completed:false,batches};
        if(activeSelection()){retire();return {completed:true,batches};}
        group.style.contentVisibility='visible';void root.scrollHeight;unwrap(group);void root.scrollHeight;batches++;
        options.onBatch?.(batches);
        if(!current())return {completed:false,batches};
        if(batches<state.groups.length)await schedule();
      }
      return {completed:current(),batches};
    }finally{options.signal.removeEventListener('abort',abort);retire();}
  };
  return {run,retire,groupCount:state.groups.length};
}
