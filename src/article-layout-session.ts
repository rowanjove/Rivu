import {layoutArticleBlocks} from './article-layout-task';
import {yieldBackgroundTask} from './background-task';
import {createArticleLayoutGroups,articleSourceHit} from './article-layout-groups';
const readyEvent='rivu-article-layout-ready';
const owners=new WeakMap<HTMLElement,()=>void>();

export function startArticleLayout(root:HTMLElement,sourceChars:number,options:{yieldTask?:()=>Promise<void>;accessibilityEnabled?:boolean}={}){
  owners.get(root)?.();
  if(options.accessibilityEnabled)return null;
  if(sourceChars<131072||!root.ownerDocument.defaultView?.CSS?.supports('content-visibility','auto'))return null;
  const grouped=createArticleLayoutGroups(root);
  // Complex/oversized paragraphs retain the original per-paragraph path.
  const blocks=grouped?[]:[...root.querySelectorAll<HTMLElement>('p')].filter(node=>!node.closest('table,pre,code'));
  if(!grouped&&blocks.length<16)return null;
  const controller=new AbortController();
  const schedule=options.yieldTask||(()=>yieldBackgroundTask(controller.signal));
  const finish=(cancelled:boolean,reason:string)=>{
    if(owners.get(root)!==cancel)return;
    grouped?.retire();owners.delete(root);root.removeAttribute('data-rivu-layout');root.removeAttribute('data-rivu-layout-mode');
    root.ownerDocument.defaultView?.removeEventListener('beforeprint',onPrint);
    root.ownerDocument.defaultView?.removeEventListener('keydown',onFind,true);
    root.removeEventListener('selectstart',onSelectStart,true);
    root.dispatchEvent(new root.ownerDocument.defaultView!.CustomEvent(readyEvent,{detail:{cancelled,reason}}));
  };
  const cancel=()=>{controller.abort();finish(true,'cancel');};
  const reveal=(reason='accessibility')=>{controller.abort();finish(false,reason);};
  const onPrint=()=>reveal('print');
  const onFind=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='f')reveal('find');};
  const onSelectStart=(event:Event)=>{
    const viewport=root.closest<HTMLElement>('.reader-content'),view=root.ownerDocument.defaultView;
    const element=view&&event.target instanceof view.Node?(event.target.nodeType===1?event.target:event.target.parentElement):null;
    const target=element&&view&&element instanceof view.HTMLElement?articleSourceHit(root,element,viewport?viewport.getBoundingClientRect().top+80:0):null;
    const top=target?.getBoundingClientRect().top;reveal('selection');
    if(viewport&&target?.isConnected&&top!==undefined)viewport.scrollTop+=target.getBoundingClientRect().top-top;
  };
  owners.set(root,cancel);root.setAttribute('data-rivu-layout','pending');
  if(grouped)root.setAttribute('data-rivu-layout-mode','groups');
  root.ownerDocument.defaultView?.addEventListener('beforeprint',onPrint);
  root.ownerDocument.defaultView?.addEventListener('keydown',onFind,true);
  root.addEventListener('selectstart',onSelectStart,true);
  const finished=(async()=>{
    if(grouped)return grouped.run({signal:controller.signal,yieldTask:schedule});
    await schedule();
    if(controller.signal.aborted)return {completed:false,batches:0};
    return layoutArticleBlocks(root,blocks,{signal:controller.signal,yieldTask:schedule,stabilize(){}});
  })().then(result=>{finish(controller.signal.aborted,result.completed?'complete':'fallback');return result;},error=>{finish(controller.signal.aborted,'fallback');return {completed:false,batches:0,error:String(error)};});
  return {cancel,reveal,finished};
}

export function waitForArticleLayout(root:HTMLElement,signal:AbortSignal):Promise<boolean>{
  if(signal.aborted||!root.isConnected)return Promise.resolve(false);
  if(root.getAttribute('data-rivu-layout')!=='pending')return Promise.resolve(true);
  return new Promise(resolve=>{
    const done=(ready:boolean)=>{root.removeEventListener(readyEvent,onReady);signal.removeEventListener('abort',onAbort);resolve(ready);};
    const onAbort=()=>done(false);
    const onReady=(event:Event)=>{if(event.target===root)done(root.isConnected&&!(event as CustomEvent).detail?.cancelled);};
    root.addEventListener(readyEvent,onReady);signal.addEventListener('abort',onAbort,{once:true});
  });
}
