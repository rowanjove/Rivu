// Install before the application mounts so the snapshot precedes its capture listener.
export function installModalKeyboardProbe(){
  window.__modalKeyTrace=[];
  const describe=node=>node?{tag:node.tagName,text:node.textContent?.trim().slice(0,60),label:node.getAttribute('aria-label'),disabled:node.matches(':disabled'),connected:node.isConnected}:null;
  const pending=new WeakMap();
  document.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const dialog=event.target.closest?.('[role="dialog"]');if(!dialog)return;
    const nodes=[...dialog.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')].filter(node=>node.tabIndex>=0&&!node.matches(':disabled,[aria-disabled="true"]')&&!node.closest('[hidden],[inert]')&&node.getClientRects().length&&!['hidden','collapse'].includes(getComputedStyle(node).visibility));
    const active=document.activeElement,expected=event.shiftKey?nodes.at(-1):nodes[0];
    const row={dialog:dialog.getAttribute('aria-label')||document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent,shift:event.shiftKey,count:nodes.length,boundary:active===(event.shiftKey?nodes[0]:nodes.at(-1)),before:describe(active),target:describe(expected)};
    pending.set(event,{row,expected});
  },true);
  document.addEventListener('keydown',event=>{
    const snapshot=pending.get(event);if(!snapshot)return;
    window.__modalKeyTrace.push({...snapshot.row,after:describe(document.activeElement),prevented:event.defaultPrevented,matched:document.activeElement===snapshot.expected});
    pending.delete(event);
  });
}
