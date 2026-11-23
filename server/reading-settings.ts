import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export type ReadingSettings = {
  density:'comfortable'|'standard'|'compact';
  uiFontSize:'small'|'standard'|'large';
  theme:'light'|'dark'|'system';font:'sans'|'serif';fontSize:14|16|18|20;
  lineHeight:1.6|1.8|2;width:680|760|840;imageWidth:'column'|'wide';linkTarget:'external'|'ask';
};
const defaults:ReadingSettings={density:'standard',uiFontSize:'standard',theme:'light',font:'sans',fontSize:16,lineHeight:1.8,width:760,imageWidth:'column',linkTarget:'external'};
const choices:Record<keyof ReadingSettings,readonly (string|number)[]>={density:['comfortable','standard','compact'],uiFontSize:['small','standard','large'],theme:['light','dark','system'],font:['sans','serif'],fontSize:[14,16,18,20],lineHeight:[1.6,1.8,2],width:[680,760,840],imageWidth:['column','wide'],linkTarget:['external','ask']};
const bad=()=>Object.assign(Error('阅读设置无效'),{statusCode:400});
function validate(input:unknown,current:ReadingSettings,complete=false):ReadingSettings{
  if(!input||typeof input!=='object'||Array.isArray(input))throw bad();
  const patch=input as Record<string,unknown>;
  if(Object.keys(patch).some(key=>!Object.hasOwn(choices,key)))throw bad();
  if(complete&&Object.keys(choices).some(key=>key!=='density'&&key!=='uiFontSize'&&!Object.hasOwn(patch,key)))throw bad();
  for(const [key,value] of Object.entries(patch))if(!choices[key as keyof ReadingSettings].includes(value as string|number))throw bad();
  return {...current,...patch} as ReadingSettings;
}
export const validateReadingSettings=(input:unknown)=>validate(input,defaults,true);

export class LocalReadingSettings {
  private current:ReadingSettings={...defaults};
  private configured=false;
  private densityConfigured=false;
  private loadError:Error|null=null;
  constructor(private path?:string){this.read();}
  private document():Record<string,unknown>{
    if(!this.path)return {};
    let value:unknown;
    try{value=JSON.parse(readFileSync(this.path,'utf8'));}catch(cause){if((cause as NodeJS.ErrnoException).code==='ENOENT')return {};throw cause;}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('设置文件格式无效，原文件未更新');
    return value as Record<string,unknown>;
  }
  private read(){
    try{
      const document=this.document(),configured=document.reading!==undefined;
      const next=configured?validateReadingSettings(document.reading):{...defaults};
      this.current=next;this.configured=configured;
      this.densityConfigured=configured&&Object.hasOwn(document.reading as object,'density');this.loadError=null;
    }catch(cause){this.loadError=Error('阅读配置读取失败，请修复本地设置文件后重新加载；原文件会保留',{cause});}
  }
  get(){if(this.path)this.read();if(this.loadError)throw this.loadError;return {preferences:{...this.current},configured:this.configured,densityConfigured:this.densityConfigured};}
  update(patch:unknown){
    validate(patch,this.current);this.get();
    const next=validate(patch,this.current);
    const persisted:Partial<ReadingSettings>={...next};
    // A legacy local density remains provisional until it is explicitly chosen.
    if(!this.densityConfigured&&!Object.hasOwn(patch as object,'density'))delete persisted.density;
    if(this.path){
      let document:Record<string,unknown>;
      try{document=this.document();if(document.reading!==undefined)validateReadingSettings(document.reading);}
      catch(cause){throw Error('无法读取现有阅读配置，原文件未更新',{cause});}
      mkdirSync(dirname(this.path),{recursive:true});
      const temp=`${this.path}.${randomUUID()}.tmp`;
      const descriptor=openSync(temp,'wx');
      try{try{writeFileSync(descriptor,JSON.stringify({...document,reading:persisted},null,2),'utf8');}finally{closeSync(descriptor);}renameSync(temp,this.path);}
      catch(cause){try{rmSync(temp,{force:true});}catch{}throw cause;}
    }
    this.current=next;this.configured=true;this.densityConfigured=Object.hasOwn(persisted,'density');
    return this.get();
  }
}
