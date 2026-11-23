import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
import {measureSettingsContrast} from './settings-contrast-probe.mjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-settings-layout-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-settings-layout-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const db=new RivuDatabase(join(directory,'rivu.db'));const category=db.addCategory('长分类'+ 'VeryLongCategory'.repeat(8));db.addFeed({title:'长订阅标题'+ 'VeryLongFeedTitle'.repeat(10),url:'https://fixture.invalid/feed',categoryId:category.id,fetchInterval:0});db.close();let app;const errors=[];const results=[];const failures=[];const contrasts=[];const shapes=[];const disabledFields=[];
const output=process.env.RIVU_TEST_SCREENSHOT_DIR?resolve(process.env.RIVU_TEST_SCREENSHOT_DIR):null;if(output)mkdirSync(output,{recursive:true});
const groups=[['general','常规'],['appearance','外观'],['reading','阅读'],['feeds','订阅'],['ai','AI'],['data','数据'],['backup','备份'],['advanced','高级'],['about','关于']];
try{
 app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});let page;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);page.on('pageerror',e=>errors.push(e.message));
 await page.evaluate(async()=>{await window.rivu.request('POST','/api/rules',{name:'Fixture local rule',enabled:false,conditions:{titleKeyword:'fixture'},action:{type:'save'}});await window.rivu.request('POST','/api/ai-rules',{name:'Fixture AI rule',conditions:{titleKeyword:'fixture'},actionType:'summary',maxItems:10});});
 for(const uiFontSize of ['small','standard','large'])for(const theme of ['light','dark']){
  await page.evaluate(({theme,uiFontSize})=>window.rivu.request('PATCH','/api/reading/settings',{theme,uiFontSize}),{theme,uiFontSize});await page.reload();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'设置',exact:true});await dialog.waitFor();await dialog.getByText('Fixture local rule',{exact:true}).waitFor();await dialog.getByText('Fixture AI rule',{exact:true}).waitFor();await page.waitForFunction(uiFontSize=>{const select=document.querySelector('#settings-appearance label:last-child select');return select&&!select.disabled&&select.value===uiFontSize;},uiFontSize);await page.waitForFunction(()=>{const button=[...document.querySelectorAll('#settings-ai button')].find(element=>element.textContent?.trim()==='保存配置');return button&&!button.disabled;});
  for(const width of [360,480,650,800,1200]){
   await page.setViewportSize({width,height:800});
   for(const [id,label] of groups){
    await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:label,exact:true}).click();
    const measurements=await dialog.evaluate(dialog=>{const scroll=dialog.querySelector('.settings-scroll'),bounds=scroll.getBoundingClientRect(),overflow=scroll.scrollWidth>scroll.clientWidth;return {dialogOverflow:dialog.scrollWidth>dialog.clientWidth,contentOverflow:overflow,dialogWidth:dialog.clientWidth,contentWidth:scroll.clientWidth,contentScrollWidth:scroll.scrollWidth,offenders:overflow?[...scroll.querySelectorAll('*')].filter(element=>element.getBoundingClientRect().right>bounds.right+1).slice(0,12).map(element=>({tag:element.tagName,class:element.className,text:element.textContent?.trim().slice(0,60),width:Math.round(element.getBoundingClientRect().width)})):[]};});
    const row={uiFontSize,theme,width,group:id,...measurements};results.push(row);if(measurements.dialogOverflow||measurements.contentOverflow)failures.push(row);
    if(output&&((measurements.dialogOverflow||measurements.contentOverflow)&&id==='feeds'||id==='ai'&&width===360||id==='about'&&width===1200))await page.screenshot({path:join(output,`${uiFontSize}-${theme}-${width}-${id}.png`)});
   }
  }
  const normalField=await dialog.evaluate(dialog=>{const field=dialog.querySelector('.ai-config input'),style=getComputedStyle(field);return {background:style.backgroundColor,color:style.color};});
  if(output&&uiFontSize==='standard'){await page.setViewportSize({width:360,height:800});for(const [selector,name] of [['.rules-settings','local-rule-form'],['.ai-rules-settings','ai-rule-form']]){await dialog.locator(selector).evaluate(element=>element.scrollIntoView({block:'start'}));await page.screenshot({path:join(output,`${theme}-${name}.png`)});}await page.setViewportSize({width:1200,height:800});}
  const appearance=await dialog.evaluate(dialog=>{const rows=[...dialog.querySelectorAll('input,select,textarea,.rule-card')].filter(element=>element.getClientRects().length&&!element.matches('input[type=checkbox],input[type=radio],input[type=hidden]')).map(element=>{const style=getComputedStyle(element),card=element.matches('.rule-card');return {tag:element.tagName,type:element.getAttribute('type'),class:element.className,card,radii:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius],expected:card?10:8,borderStyle:style.borderTopStyle,borderWidth:style.borderTopWidth};});return {checked:rows.length,cards:rows.filter(row=>row.card).length,failures:rows.filter(row=>row.radii.some(radius=>parseFloat(radius)!==row.expected)||row.borderStyle!=='solid'||parseFloat(row.borderWidth)!==1)};});shapes.push({uiFontSize,theme,...appearance});assert.equal(appearance.cards,2,'both saved rule cards render before appearance checks');
  contrasts.push({uiFontSize,theme,state:'loaded',...await dialog.evaluate(measureSettingsContrast)});
  const danger=dialog.locator('button.danger:enabled').first();if(await danger.count()){await danger.hover();contrasts.push({uiFontSize,theme,state:'danger-hover',...await dialog.evaluate(measureSettingsContrast)});}
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await app.evaluate(({ipcMain})=>{globalThis.__settingsOriginal=ipcMain._invokeHandlers.get('rivu:request');ipcMain._invokeHandlers.set('rivu:request',async(...args)=>{const [,method,path]=args;if(method==='GET'&&['/api/network/proxy','/api/ai/settings'].includes(path))throw Error('fixture settings read failure');const result=await globalThis.__settingsOriginal(...args);if(method==='GET'&&path==='/api/backups/automatic')return {...result,lastError:'fixture backup failure'};if(method==='GET'&&path==='/api/storage/maintenance')return {...result,lastError:'fixture maintenance failure'};return result;});});
  await page.getByRole('button',{name:'设置',exact:true}).click();await dialog.getByRole('status').filter({hasText:'fixture settings read failure'}).waitFor();await dialog.getByRole('alert').filter({hasText:'代理配置读取失败'}).waitFor();await dialog.getByRole('alert').filter({hasText:'fixture backup failure'}).waitFor();await dialog.getByRole('alert').filter({hasText:'fixture maintenance failure'}).waitFor();contrasts.push({uiFontSize,theme,state:'read-error',...await dialog.evaluate(measureSettingsContrast)});
const disabledField=await dialog.evaluate(dialog=>{const field=dialog.querySelector('.ai-config input'),style=getComputedStyle(field);return {disabled:field.matches(':disabled'),background:style.backgroundColor,color:style.color,cursor:style.cursor};});disabledFields.push({uiFontSize,theme,normal:normalField,disabled:disabledField});assert.equal(disabledField.disabled,true);assert.notEqual(disabledField.background,normalField.background);assert.notEqual(disabledField.color,normalField.color);assert.equal(disabledField.cursor,'not-allowed');
  if(output){await page.setViewportSize({width:360,height:800});await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'高级',exact:true}).click();await page.screenshot({path:join(output,`${uiFontSize}-${theme}-360-read-error.png`)});await page.setViewportSize({width:1200,height:800});}
  await app.evaluate(({ipcMain})=>{ipcMain._invokeHandlers.set('rivu:request',globalThis.__settingsOriginal);delete globalThis.__settingsOriginal;});
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
 }
 if(output)writeFileSync(join(output,'measurements.json'),JSON.stringify({results,failures,contrasts,shapes,disabledFields,errors},null,2));console.log(JSON.stringify({checks:results.length,failures,contrasts,shapes,disabledFields,errors},null,2));assert.deepEqual(errors,[]);assert.equal(failures.length,0,'all settings groups fit their scroll column');assert.equal(contrasts.reduce((total,theme)=>total+theme.failures.length,0),0,'enabled settings text retains readable contrast');assert.equal(shapes.reduce((total,theme)=>total+theme.failures.length,0),0,'settings inputs use 8px and cards use 10px PRD radii');
}finally{if(app)await app.evaluate(({ipcMain})=>{if(globalThis.__settingsOriginal)ipcMain._invokeHandlers.set('rivu:request',globalThis.__settingsOriginal);}).catch(()=>{});await app?.close();rmSync(directory,{recursive:true,force:true});}









