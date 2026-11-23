// Bounded layout work for the reader's deferred paragraphs.
const owners=new WeakMap<HTMLElement,()=>void>();
export async function layoutArticleBlocks(
  root: HTMLElement,
  blocks: readonly HTMLElement[],
  options: {
    signal: AbortSignal;
    yieldTask: () => Promise<void>;
    stabilize: () => void;
    batchSize?: number;
    onBatch?: (count: number) => void;
  },
): Promise<{completed: boolean; batches: number}> {
  const size=options.batchSize??8;
  if(!Number.isInteger(size)||size<1||size>32)throw new RangeError('Invalid article layout batch size');
  owners.get(root)?.();
  const changed=new Map<HTMLElement,{value:string;priority:string;hadStyle:boolean}>();
  let batches=0,retired=false;
  const retire=()=>{
    if(retired)return;retired=true;
    for(const [block,original] of changed){
      if(original.value)block.style.setProperty('content-visibility',original.value,original.priority);
      else block.style.removeProperty('content-visibility');
      if(!original.hadStyle&&block.getAttribute('style')==='')block.removeAttribute('style');
    }
    changed.clear();
    if(owners.get(root)===retire)owners.delete(root);
  };
  owners.set(root,retire);
  const current=()=>!retired&&!options.signal.aborted&&root.isConnected;
  try{
    for(let i=0;i<blocks.length;i+=size){
      if(!current())return {completed:false,batches};
      const batch=blocks.slice(i,i+size);
      if(batch.some(block=>!root.contains(block)))return {completed:false,batches};
      for(const block of batch){
        if(!changed.has(block))changed.set(block,{value:block.style.getPropertyValue('content-visibility'),priority:block.style.getPropertyPriority('content-visibility'),hadStyle:block.hasAttribute('style')});
        block.style.setProperty('content-visibility','visible');
      }
      options.stabilize();
      if(!current())return {completed:false,batches};
      // Force this batch's layout before yielding, rather than deferring all cost.
      void root.scrollHeight;
      batches++;
      options.onBatch?.(batch.length);
      if(i+size<blocks.length)await options.yieldTask();
    }
    return {completed:current(),batches};
  }finally{
    // Touch only nodes owned by this run, even if a new article replaced the root's children.
    retire();
  }
}
