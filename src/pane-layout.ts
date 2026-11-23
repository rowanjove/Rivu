export type PaneLayout={navigationCollapsed:boolean;listCompact:boolean};
const key='rivu-pane-layout';
export function loadPaneLayout():PaneLayout{
 try{const value=JSON.parse(localStorage.getItem(key)||'null');return {navigationCollapsed:value?.navigationCollapsed===true,listCompact:value?.listCompact===true};}
 catch{return {navigationCollapsed:false,listCompact:false};}
}
export function savePaneLayout(value:PaneLayout){try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Layout remains usable when local storage is unavailable. */}}
