import {createArticleAnchor,parseArticleAnchor,resolveArticleAnchor,type ArticleAnchor} from './article-anchor';
import {articleSourceRevision} from './article-revision';
import {waitForArticleLayout} from './article-layout-session';
import {articleSourceHit} from './article-layout-groups';
export {articleSourceRevision} from './article-revision';

type Position={progress:number;updated_at?:string;anchor?:ArticleAnchor};
type Journal=Position&{at:number;token?:number};
const saves=new Map<string,Promise<void>>();
let journalSequence=0;

export function trackReadingPosition(element:HTMLElement,entryId:string,source:string,transport:{
  read:()=>Promise<Position>;
  write:(position:Position)=>Promise<unknown>;
  revision?:(source:string,signal?:AbortSignal)=>Promise<string>;
}):()=>void {
  const journalKey=`rivu-reading-pending:${entryId}`,view=element.ownerDocument.defaultView!;
  const digestController=new AbortController();
  const restorationController=new AbortController();
  let active=true,restored=false,dirty=false,hasLocalPosition=false,adjusting=false,userInteracted=false,currentProgress=0,revision:string|null=null,currentAnchor:ArticleAnchor|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined,anchor:{node:HTMLElement;top:number}|null=null;
  let restoringScroll=false,lastHandledScrollTop:number|undefined;
  const progress=()=>Math.max(0,Math.min(1,element.scrollTop/Math.max(1,element.scrollHeight-element.clientHeight)));
  const body=()=>{const root=element.querySelector<HTMLElement>('.rich-body');return root&&!root.closest('[hidden]')?root:null;};
  const readJournal=():Journal|null=>{try{
    const value=JSON.parse(view.localStorage.getItem(journalKey)||'null');
    if(!value||typeof value.progress!=='number'||!Number.isFinite(value.progress)||value.progress<0||value.progress>1||!Number.isFinite(value.at))return null;
    return {...value,anchor:parseArticleAnchor(value.anchor)??undefined};
  }catch{return null;}};
  const captureAnchor=()=>{
    const bounds=element.getBoundingClientRect(),doc=element.ownerDocument;
    const root=body();let node:HTMLElement|null=null;
    // A single point may hit the body's padding or a paragraph margin. Probe a
    // bounded number of nearby content points rather than scanning every block.
    for(const x of [bounds.left+80,(bounds.left+bounds.right)/2]){
      for(const y of [bounds.top+80,bounds.top+96,bounds.top+64]){
        const pointY=Math.min(bounds.bottom-1,y),hit=doc.elementFromPoint(Math.min(bounds.right-1,x),pointY);
        if(hit instanceof view.HTMLElement&&element.contains(hit)){
          const sourceHit=root&&root.contains(hit)?articleSourceHit(root,hit,pointY):hit;
          if(!sourceHit)continue;
          node??=sourceHit;
          if(root&&sourceHit!==root&&root.contains(sourceHit)){node=sourceHit;break;}
        }
      }
      if(node&&root&&node!==root&&root.contains(node))break;
    }
    anchor=node&&node!==element?{node,top:node.getBoundingClientRect().top-bounds.top}:null;
    observeAnchorPredecessors();
    currentAnchor=root&&node&&revision?createArticleAnchor(root,node,revision,node.getBoundingClientRect().top-bounds.top):null;
  };
  const save=()=>{
    if(!dirty)return;
    const snapshot:Position={progress:currentProgress,...(currentAnchor?{anchor:currentAnchor}:{})},record=readJournal();dirty=false;
    const task=(saves.get(entryId)||Promise.resolve()).catch(()=>{}).then(async()=>{
      await transport.write(snapshot);const journal=readJournal();
      if(record&&journal?.at===record.at&&journal.progress===record.progress&&journal.token===record.token)
        try{view.localStorage.removeItem(journalKey);}catch{/* Keep database success if storage is unavailable. */}
    });
    saves.set(entryId,task);
    void task.catch(()=>{}).finally(()=>{if(saves.get(entryId)===task)saves.delete(entryId);});
  };
  const markDirty=()=>{
    currentProgress=progress();dirty=true;hasLocalPosition=true;
    try{view.localStorage.setItem(journalKey,JSON.stringify({progress:currentProgress,...(currentAnchor?{anchor:currentAnchor}:{}),at:Date.now(),token:++journalSequence}));}catch{/* Database saving still runs. */}
    if(timer)clearTimeout(timer);timer=setTimeout(save,450);
  };
  const onScroll=()=>{
    if(!active||!restored||restoringScroll&&!userInteracted)return;
    const top=element.scrollTop;
    // A queued scroll event can repeat the current position after a reflow.
    // Keep the old anchor until the resize observer can compensate the shift.
    if(top===lastHandledScrollTop)return;
    lastHandledScrollTop=top;if(!adjusting)captureAnchor();markDirty();
  };
  const onIntent=(event:Event)=>{
    if(event.type==='pointerdown'&&(event.target as HTMLElement|null)?.closest('button,a,input,textarea,select,[role="button"],[contenteditable]'))return;
    if(event.type==='keydown'){
      const key=event as KeyboardEvent,target=event.target as HTMLElement|null;
      if(!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(key.key)||key.ctrlKey||key.altKey||key.metaKey||target?.closest('input,textarea,select,[contenteditable]'))return;
      if(key.key===' '&&target?.closest('button,[role="button"]'))return;
    }
    userInteracted=true;restoringScroll=false;restorationController.abort();adjusting=false;if(!restored){restored=true;captureAnchor();}
  };
  const onResize=()=>{
    if(!active||!restored)return;
    if(anchor&&element.contains(anchor.node)){
      const delta=anchor.node.getBoundingClientRect().top-element.getBoundingClientRect().top-anchor.top;
      if(Math.abs(delta)>1){adjusting=true;element.scrollTop+=delta;lastHandledScrollTop=element.scrollTop;view.requestAnimationFrame(()=>{if(active)adjusting=false;});markDirty();}
      else if(Math.abs(progress()-currentProgress)>1e-9)markDirty();
    }else{element.scrollTop=currentProgress*Math.max(0,element.scrollHeight-element.clientHeight);lastHandledScrollTop=element.scrollTop;captureAnchor();markDirty();}
  };
  const observer=new ResizeObserver(onResize),observed=new Set<Element>();
  const observeAnchorPredecessors=()=>{
    const targets=new Set<Element>(element.children);
    // Opposite size changes can keep the body height constant. Watch the
    // immediate predecessor at each nearby nesting level without scanning it.
    let node:Element|null=anchor&&element.contains(anchor.node)?anchor.node:null;
    for(let depth=0;node&&node!==element&&depth<8;depth++,node=node.parentElement){
      if(node.previousElementSibling)targets.add(node.previousElementSibling);
    }
    for(const target of observed)if(!targets.has(target)){observer.unobserve(target);observed.delete(target);}
    for(const target of targets)if(!observed.has(target)){observer.observe(target,{box:'border-box'});observed.add(target);}
  };
  const observeChildren=()=>{if(active)observeAnchorPredecessors();};
  observeChildren();const mutations=new MutationObserver(observeChildren);mutations.observe(element,{childList:true});
  element.addEventListener('scroll',onScroll,{passive:true});
  for(const type of ['wheel','touchmove','pointerdown','keydown'])element.addEventListener(type,onIntent,{passive:true});
  view.addEventListener('pagehide',save);
  const revisionReady=(transport.revision||articleSourceRevision)(source,digestController.signal).catch(()=>null).then(value=>{
    revision=value;if(active&&restored){captureAnchor();if(dirty||(hasLocalPosition&&currentAnchor))markDirty();}return value;
  });
  const restore=async(position:Position,recover:boolean)=>{
    if(!active||userInteracted)return;
    const pendingRoot=body(),knownAnchor=pendingRoot&&revision?resolveArticleAnchor(pendingRoot,position.anchor,revision):null;
    // Skipped groups above the saved paragraph still have estimated heights.
    // Resolving its source path does not make its scroll coordinate stable.
    if(pendingRoot&&(knownAnchor?pendingRoot.dataset.rivuLayoutMode==='groups':position.progress>0)&&!await waitForArticleLayout(pendingRoot,restorationController.signal))return;
    if(!active||userInteracted)return;
    view.requestAnimationFrame(()=>{
      if(!active||userInteracted)return;
      const align=()=>{
        const root=body(),saved=root&&revision?resolveArticleAnchor(root,position.anchor,revision):null;
        if(saved)element.scrollTop+=saved.node.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.offset;
        else element.scrollTop=position.progress*Math.max(0,element.scrollHeight-element.clientHeight);
        currentProgress=progress();
      };
      restoringScroll=true;align();
      // Deferred blocks can grow between these frames while resize handling is
      // still paused. Reapply the saved source point before accepting a new one.
      view.requestAnimationFrame(()=>{if(active&&!userInteracted){align();restored=true;captureAnchor();if(recover)markDirty();view.requestAnimationFrame(()=>{if(active)restoringScroll=false;});}});
    });
  };
  const previous=saves.get(entryId)||Promise.resolve();
  void previous.catch(()=>{}).then(()=>{if(!active)throw Error('Reading position retired');return transport.read();}).then(async position=>{
    await revisionReady;if(!active||userInteracted)return;
    const journal=readJournal(),savedAt=Date.parse(position.updated_at||'')||0,recover=!!journal&&journal.at>savedAt;
    if(journal&&!recover)try{view.localStorage.removeItem(journalKey);}catch{/* Database is already current. */}
    restore(recover?journal!:position,recover);
  }).catch(async()=>{
    await revisionReady;if(!active||userInteracted)return;
    const journal=readJournal();if(journal)restore(journal,true);else{restored=true;currentProgress=progress();captureAnchor();}
  });
  return ()=>{
    active=false;digestController.abort();restorationController.abort();element.removeEventListener('scroll',onScroll);
    for(const type of ['wheel','touchmove','pointerdown','keydown'])element.removeEventListener(type,onIntent);
    view.removeEventListener('pagehide',save);mutations.disconnect();observer.disconnect();if(timer)clearTimeout(timer);save();
  };
}
