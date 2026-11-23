import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { setProxyPreferences, type ProxyPreferences } from './network';

export const defaultProxyPreferences:ProxyPreferences={mode:'environment',httpProxy:'',httpsProxy:'',noProxy:''};
const invalid=()=>Object.assign(Error('代理设置无效'),{statusCode:400});

export function validateProxyPreferences(input:unknown):ProxyPreferences{
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid();
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(key=>!Object.hasOwn(defaultProxyPreferences,key))||Object.keys(defaultProxyPreferences).some(key=>!Object.hasOwn(value,key)))throw invalid();
  if(typeof value.mode!=='string'||!['environment','direct','custom'].includes(value.mode)||typeof value.httpProxy!=='string'||typeof value.httpsProxy!=='string'||typeof value.noProxy!=='string')throw invalid();
  for(const field of ['httpProxy','httpsProxy'] as const){
    const raw=value[field] as string;
    if(raw.length>2048)throw invalid();
    if(raw){try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw invalid();}catch{throw invalid();}}
  }
  const noProxy=value.noProxy as string;
  if(noProxy.length>1024||!/^[-\w.*,:\[\]\s]*$/.test(noProxy)||/[\r\n]/.test(noProxy))throw invalid();
  if(value.mode==='custom'&&!value.httpProxy&&!value.httpsProxy)throw invalid();
  return {mode:value.mode as ProxyPreferences['mode'],httpProxy:value.httpProxy,httpsProxy:value.httpsProxy,noProxy};
}

export class LocalProxySettings{
  private current:ProxyPreferences={...defaultProxyPreferences};
  private loadError:Error|null=null;
  constructor(private path?:string){this.read();}
  private document():Record<string,unknown>{
    if(!this.path)return {};
    let value:unknown;
    try{value=JSON.parse(readFileSync(this.path,'utf8'));}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return {};throw cause;}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('设置文件格式无效');
    return value as Record<string,unknown>;
  }
  private read(){
    try{const document=this.document(),next=document.proxy===undefined?{...defaultProxyPreferences}:validateProxyPreferences(document.proxy);this.current=next;this.loadError=null;setProxyPreferences(next);}
    catch(cause){this.loadError=Error('代理配置读取失败，请修复本地设置文件后重新加载；原文件会保留，公开内容请求已暂停',{cause});setProxyPreferences(this.current,this.loadError.message);}
  }
  get(){if(this.path)this.read();if(this.loadError)throw this.loadError;return {...this.current};}
  update(patch:unknown){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw invalid();
    if(Object.keys(patch).some(key=>!Object.hasOwn(defaultProxyPreferences,key)))throw invalid();this.get();
    const next=validateProxyPreferences({...this.current,...patch as Record<string,unknown>});
    if(this.path){
      const document=this.document();
      mkdirSync(dirname(this.path),{recursive:true});
      const temp=`${this.path}.${randomUUID()}.tmp`;
      const descriptor=openSync(temp,'wx');
      try{try{writeFileSync(descriptor,JSON.stringify({...document,proxy:next},null,2),'utf8');}finally{closeSync(descriptor);}renameSync(temp,this.path);}
      catch(cause){try{rmSync(temp,{force:true});}catch{}throw cause;}
    }
    this.current=next;setProxyPreferences(next);
    return {...this.current};
  }
}
