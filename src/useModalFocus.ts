import {useEffect,useRef,type RefObject} from 'react';

const scopes:HTMLElement[]=[];
const available=(element:HTMLElement)=>!element.matches(':disabled,[aria-disabled="true"]')&&!element.closest('[hidden],[inert]')&&element.getClientRects().length>0&&!['hidden','collapse'].includes(getComputedStyle(element).visibility);
const controls=(dialog:HTMLElement)=>Array.from(dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]'))
  .filter(element=>element.tabIndex>=0&&available(element));

export function useModalFocus(target:RefObject<HTMLElement|null>|string,onClose:()=>void){
  const close=useRef(onClose);close.current=onClose;
  const restore=useRef(typeof document!=='undefined'&&document.activeElement instanceof HTMLElement?document.activeElement:null);
  useEffect(()=>{
    const dialog=typeof target==='string'?document.querySelector<HTMLElement>(target):target.current;
    if(!dialog)return;
    const previous=restore.current;
    const ancestorIndex=scopes.findIndex(scope=>dialog.contains(scope));
    if(ancestorIndex<0)scopes.push(dialog);else scopes.splice(ancestorIndex,0,dialog);
    const elements=controls(dialog),active=document.activeElement;
    if(scopes.at(-1)===dialog)(elements.includes(active as HTMLElement)?active as HTMLElement:elements[0]||dialog).focus();
    const keydown=(event:KeyboardEvent)=>{
      if(scopes.at(-1)!==dialog||event.defaultPrevented||event.isComposing)return;
      if(event.key==='Escape'){
        event.preventDefault();event.stopPropagation();close.current();
      }else if(event.key==='Tab'){
        const elements=controls(dialog),first=elements[0],last=elements.at(-1),active=document.activeElement;
        const outside=!active||!dialog.contains(active),container=active===dialog;
        const beforeFirst=!!(active&&first&&(active.compareDocumentPosition(first)&Node.DOCUMENT_POSITION_FOLLOWING));
        const afterLast=!!(active&&last&&(last.compareDocumentPosition(active)&Node.DOCUMENT_POSITION_FOLLOWING));
        if(!first){event.preventDefault();dialog.focus();}
        else if(event.shiftKey&&(active===first||outside||container||beforeFirst)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&(active===last||outside||container||afterLast)){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',keydown,true);
    return()=>{
      document.removeEventListener('keydown',keydown,true);
      const wasTop=scopes.at(-1)===dialog,index=scopes.lastIndexOf(dialog);if(index>=0)scopes.splice(index,1);
      if(wasTop){
        const parent=scopes.at(-1);
        if(previous?.isConnected&&!dialog.contains(previous)&&(!parent||parent.contains(previous))&&available(previous))previous.focus();
        else if(parent?.isConnected)(controls(parent)[0]||parent).focus();
      }
    };
  },[target]);
}
