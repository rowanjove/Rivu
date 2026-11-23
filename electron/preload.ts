import { contextBridge, ipcRenderer } from 'electron';
import {decodeImageBinaryTransport,imageBinaryPayload} from './image-transport';
import {isEntryResult,decodeEntryTransport,isFeedPatch,decodeFeedTransport,isImageRead,decodeImageTransport} from './entry-transport';
let accessibilityEnabled=process.argv.filter(value=>value.startsWith('--rivu-accessibility=')).at(-1)!=='--rivu-accessibility=0',accessibilityRevision=0;
const accessibilityListeners=new Set<(enabled:boolean)=>void>();
ipcRenderer.on('rivu:accessibility-changed',(_event,value:unknown)=>{
  accessibilityEnabled=typeof value==='boolean'?value:true;accessibilityRevision++;
  for(const callback of accessibilityListeners)callback(accessibilityEnabled);
});
contextBridge.exposeInMainWorld('rivu', {
  diagnostics:()=>ipcRenderer.invoke('rivu:diagnostics'),
  accessibilitySupportEnabled:()=>accessibilityEnabled,
  onAccessibilitySupportChanged:(callback:(enabled:boolean)=>void)=>{
    accessibilityListeners.add(callback);const revision=accessibilityRevision;
    void ipcRenderer.invoke('rivu:accessibility-state').then((value:unknown)=>{
      if(accessibilityRevision===revision){accessibilityEnabled=typeof value==='boolean'?value:true;if(accessibilityListeners.has(callback))callback(accessibilityEnabled);}
    }).catch(()=>{if(accessibilityRevision===revision&&accessibilityListeners.has(callback)){accessibilityEnabled=true;callback(true);}});
    return ()=>{accessibilityListeners.delete(callback);};
  },
  setWindowTheme:(theme:'light'|'dark')=>ipcRenderer.invoke('rivu:window-theme',theme),
  imageUrl:(entryId:string,url:string,mode:'lookup'|'load'='load')=>ipcRenderer.invoke('rivu:image-url',entryId,url,mode),
  cancelImageUrl:(url:string)=>ipcRenderer.invoke('rivu:image-cancel',url),
  readImageUrl:async(url:string)=>imageBinaryPayload(await ipcRenderer.invoke('rivu:image-bytes',url)),
  request: async(method:string,path:string,body?:unknown)=>{
    const result=await ipcRenderer.invoke('rivu:request',method,path,body);
    return isImageRead(method,path)?(result&&typeof result==='object'&&'imageBytes' in result?decodeImageBinaryTransport(result):decodeImageTransport(result)):isFeedPatch(method,path)?decodeFeedTransport(result):isEntryResult(method,path)?decodeEntryTransport(result):result;
  },
  chooseFile: (kind:'backup')=>ipcRenderer.invoke('rivu:choose-file',kind),
  previewOpml: ()=>ipcRenderer.invoke('rivu:preview-opml'),
  importOpml: (id:string,options:{selected:number[];categoryMap:Record<string,string|null>})=>ipcRenderer.invoke('rivu:import-opml',id,options),
  previewNewsletter: ()=>ipcRenderer.invoke('rivu:preview-newsletter'),
  subscribeNewsletter: (id:string,title:string,categoryId?:string)=>ipcRenderer.invoke('rivu:subscribe-newsletter',id,title,categoryId),
  reconnectNewsletter: (id:string)=>ipcRenderer.invoke('rivu:reconnect-newsletter',id),
  saveFile: (kind:'opml'|'backup'|'archive',options?:{includeSecrets?:boolean;archiveId?:string})=>ipcRenderer.invoke('rivu:save-file',kind,options),
  openExternal: (url:string)=>ipcRenderer.invoke('rivu:open-external',url),
  onExternalError: (callback:(message:string)=>void)=>{
    const listener=(_event:Electron.IpcRendererEvent,message:unknown)=>{if(typeof message==='string')callback(message);};
    ipcRenderer.on('rivu:external-error',listener);
    return ()=>{ipcRenderer.removeListener('rivu:external-error',listener);};
  },
  openBackupDirectory: ()=>ipcRenderer.invoke('rivu:open-backup-directory')
});
