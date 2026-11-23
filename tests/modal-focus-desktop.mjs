import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {_electron as electron} from 'playwright-core';
import {installModalKeyboardProbe} from './modal-keyboard-probe.mjs';
assert.ok(process.env.RIVU_TEST_EXE);
const data=mkdtempSync(join(tmpdir(),'rivu-modal-keys-'));
const cleanupRelative=relative(resolve(tmpdir()),resolve(data));
assert.ok(cleanupRelative&&!cleanupRelative.startsWith('..')&&!isAbsolute(cleanupRelative)&&cleanupRelative.startsWith('rivu-modal-keys-'));
const fixture=createServer((req,res)=>{
  if(req.url==='/json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[{id:'json',title:'JSON keyboard',content:'Local body'}]}));}
  else if(req.url==='/feed'){res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>Keyboard</title><item><guid>keyboard</guid><title>Keyboard article</title><description>Local body</description></item></channel></rss>');}
  else{res.statusCode=404;res.end();}
});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let application;
try{
  application=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:data}});
  let page;const deadline=Date.now()+30000;
  while(Date.now()<deadline){page=application.windows().find(window=>window.url().includes('/index.html'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(page);await page.getByRole('button',{name:'添加订阅',exact:true}).first().waitFor();
  await page.addInitScript(installModalKeyboardProbe);await page.evaluate(installModalKeyboardProbe);
  async function assertEvent(cursor,shift,label){
    const result=await page.evaluate(()=>({count:window.__modalKeyTrace.length,event:window.__modalKeyTrace.at(-1)}));
    const event=result.event,ok=result.count===cursor+1&&event?.shift===shift&&event.boundary&&event.prevented&&event.matched;
    if(!ok)console.error('Event-time focus diagnostic',JSON.stringify(result));
    assert.ok(ok,`${label} reaches its event-time boundary target`);
  }
  async function checkCycle(dialog){
    await dialog.waitFor();assert.equal(await dialog.getAttribute('aria-modal'),'true');
    assert.ok(await dialog.evaluate(element=>element.contains(document.activeElement)),'initial focus stays within dialog');
    const selector='button,input,select,textarea,a[href],[tabindex]';
    await dialog.evaluate((element,selector)=>{const controls=[...element.querySelectorAll(selector)].filter(control=>control.tabIndex>=0&&!control.matches(':disabled,[aria-disabled="true"]')&&!control.closest('[hidden],[inert]')&&control.getClientRects().length&&!['hidden','collapse'].includes(getComputedStyle(control).visibility));controls.at(-1).focus();},selector);
    const forwardCursor=await page.evaluate(()=>window.__modalKeyTrace.length);await page.keyboard.press('Tab');await assertEvent(forwardCursor,false,'Tab');
    assert.ok(await dialog.evaluate((element,selector)=>{const controls=[...element.querySelectorAll(selector)].filter(control=>control.tabIndex>=0&&!control.matches(':disabled,[aria-disabled="true"]')&&!control.closest('[hidden],[inert]')&&control.getClientRects().length&&!['hidden','collapse'].includes(getComputedStyle(control).visibility));return document.activeElement===controls[0];},selector),'Tab wraps to first control');
    const reverseCursor=await page.evaluate(()=>window.__modalKeyTrace.length);await page.keyboard.press('Shift+Tab');await assertEvent(reverseCursor,true,'Shift+Tab');
    const reverse=await dialog.evaluate((element,selector)=>{const controls=[...element.querySelectorAll(selector)].filter(control=>control.tabIndex>=0&&!control.matches(':disabled,[aria-disabled="true"]')&&!control.closest('[hidden],[inert]')&&control.getClientRects().length&&!['hidden','collapse'].includes(getComputedStyle(control).visibility));const describe=node=>node?{tag:node.tagName,text:node.textContent?.trim().slice(0,90),label:node.getAttribute('aria-label'),section:node.closest('section')?.id,hidden:!!node.closest('[hidden],[inert]'),visibility:getComputedStyle(node).visibility,disabled:node.matches(':disabled')}:null;return {ok:document.activeElement===controls.at(-1),active:describe(document.activeElement),first:describe(controls[0]),last:describe(controls.at(-1)),count:controls.length};},selector);
    if(!reverse.ok)console.error('Reverse focus diagnostic',JSON.stringify({reverse,trace:await page.evaluate(()=>window.__modalKeyTrace)}));
    assert.ok(reverse.ok,'Shift+Tab wraps to last control');
    await page.evaluate(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true})));
    assert.equal(await dialog.isVisible(),true,'IME composition Escape does not close');
  }
  const add=page.getByRole('button',{name:'添加订阅',exact:true}).first();await add.click();
  const addDialog=page.getByRole('dialog',{name:'添加订阅',exact:true});await checkCycle(addDialog);
  const urlInput=addDialog.getByPlaceholder('https://example.com');await urlInput.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  assert.deepEqual(await urlInput.evaluate(element=>{const style=getComputedStyle(element);return [style.outlineStyle,style.outlineWidth];}),['solid','2px'],'keyboard focus is visible on the URL field');
  assert.equal(await addDialog.evaluate(element=>getComputedStyle(element).animationName),'rivu-dialog-appear');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await addDialog.evaluate(element=>getComputedStyle(element).animationName),'none','system reduced motion disables dialog animation');
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const width of [360,480,800,1200]){
    await page.setViewportSize({width,height:800});
    for(const label of ['RSS / 网站','RSSHub','JSON API','Newsletter']){
      await addDialog.getByRole('button',{name:label,exact:true}).click();
      assert.equal(await addDialog.evaluate(element=>element.scrollWidth<=element.clientWidth),true,`${label} at ${width}px has no horizontal overflow`);
      assert.equal(await addDialog.locator('.source-tabs').evaluate(element=>element.scrollWidth<=element.clientWidth),true,'all source tabs fit without horizontal scrolling');
    }
  }
  await page.setViewportSize({width:1200,height:800});await page.keyboard.press('Escape');await addDialog.waitFor({state:'detached'});
  assert.ok(await add.evaluate(element=>element===document.activeElement),'autofocus modal restores original opener');
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>window.rivu.request('PATCH','/api/reading/settings',{theme}),theme);await page.reload();
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    await add.click();const field=addDialog.getByPlaceholder('https://example.com');await field.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
    assert.equal(await field.evaluate(element=>getComputedStyle(element).outlineColor),theme==='dark'?'rgb(143, 211, 255)':'rgb(35, 124, 180)');
    if(theme==='dark'){
      const contrast=await addDialog.evaluate(dialog=>{
        const luminance=color=>color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[0.2126,0.7152,0.0722][i],0);
        const background=luminance(getComputedStyle(dialog).backgroundColor);
        return [...dialog.querySelectorAll(':scope > p,.local-network-option,.source-tabs button')].map(element=>{const text=luminance(getComputedStyle(element).color);return (Math.max(text,background)+0.05)/(Math.min(text,background)+0.05);});
      });
      assert.ok(contrast.length>=5&&contrast.every(value=>value>=4.5),'dark dialog descriptions, authorization label and source tabs retain readable contrast');
    }
    for(const width of [360,800,1200]){
      await page.setViewportSize({width,height:800});
      assert.equal(await addDialog.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
      if(process.env.RIVU_TEST_SCREENSHOT_DIR)await page.screenshot({path:resolve(process.env.RIVU_TEST_SCREENSHOT_DIR,`add-focus-${theme}-${width}.png`)});
    }
    await page.keyboard.press('Escape');await addDialog.waitFor({state:'detached'});
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
  const importing=page.getByRole('button',{name:'导入 OPML',exact:true});await importing.click();const importDialog=page.getByRole('dialog');await checkCycle(importDialog);await page.keyboard.press('Escape');await importDialog.waitFor({state:'detached'});assert.ok(await importing.evaluate(element=>element===document.activeElement));
  await page.evaluate(async base=>{
    await window.rivu.request('POST','/api/feeds',{url:base+'/feed',allowPrivate:true});
    await window.rivu.request('POST','/api/feeds/custom-json',{url:base+'/json',title:'JSON keyboard',allowPrivate:true,mapping:{itemsPath:'items',titlePath:'title',idPath:'id',urlPath:'',datePath:'',contentPath:'content',summaryPath:'',authorPath:'',imagePath:''}});
  },`http://127.0.0.1:${fixture.address().port}`);
  await page.reload();await page.locator('.entry-row').first().waitFor();await page.locator('.entry-row').first().click();
  const tags=page.getByTitle('标签',{exact:true});await tags.click();const tagDialog=page.getByRole('dialog');await checkCycle(tagDialog);await page.keyboard.press('Escape');await tagDialog.waitFor({state:'detached'});assert.ok(await tags.evaluate(element=>element===document.activeElement));
  const archives=page.getByRole('button',{name:'永久归档',exact:true});await archives.click();const archiveDialog=page.getByRole('dialog',{name:'永久归档',exact:true});await page.waitForFunction(()=>{const button=[...document.querySelectorAll('.archive-modal button')].find(element=>element.textContent==='刷新归档');return button&&!button.disabled;});await checkCycle(archiveDialog);await page.keyboard.press('Escape');await archiveDialog.waitFor({state:'detached'});assert.ok(await archives.evaluate(element=>element===document.activeElement));
  await page.getByRole('button',{name:'设置',exact:true}).click();const settings=page.getByRole('dialog',{name:'设置',exact:true});await checkCycle(settings);
  await settings.getByRole('button',{name:'订阅',exact:true}).click();
  await page.keyboard.press('Tab');
  const sectionFocus=await page.evaluate(()=>({placeholder:document.activeElement?.getAttribute('placeholder'),label:document.activeElement?.getAttribute('aria-label'),tag:document.activeElement?.tagName}));console.log('Section Tab',JSON.stringify(sectionFocus));
  assert.equal(sectionFocus.placeholder,'新分类名称','Tab after the selected section heading enters that section');
  await settings.getByRole('button',{name:'订阅',exact:true}).click();await page.keyboard.press('Shift+Tab');
  assert.ok(await settings.getByRole('button',{name:'恢复阅读默认值',exact:true}).evaluate(element=>element===document.activeElement),'reverse Tab from subscriptions heading follows preceding control');
  await settings.getByRole('button',{name:'关于',exact:true}).click();await page.keyboard.press('Tab');
  assert.ok(await settings.getByRole('button',{name:'关闭设置',exact:true}).evaluate(element=>element===document.activeElement),'Tab after final heading wraps to first control');
  await settings.getByRole('button',{name:'关于',exact:true}).click();await page.keyboard.press('Shift+Tab');
  assert.ok(await settings.getByRole('button',{name:'优化数据库',exact:true}).evaluate(element=>element===document.activeElement),'reverse Tab from final heading follows preceding control');
  await settings.getByRole('button',{name:'订阅',exact:true}).click();
  const edit=settings.getByRole('button',{name:'编辑 JSON 字段映射',exact:true});await edit.click();
  const nested=page.getByRole('dialog',{name:'编辑 JSON 字段映射',exact:true});await checkCycle(nested);await page.keyboard.press('Escape');await nested.waitFor({state:'detached'});assert.equal(await settings.isVisible(),true);assert.ok(await edit.evaluate(element=>element===document.activeElement),'nested dialog returns focus to settings opener');
  await edit.click();await nested.waitFor();const opener=await edit.elementHandle();assert.ok(opener);
  await opener.evaluate(element=>element.style.display='none');await page.keyboard.press('Escape');await nested.waitFor({state:'detached'});
  assert.ok(await settings.getByRole('button',{name:'关闭设置',exact:true}).evaluate(element=>element===document.activeElement),'hidden nested opener falls back to usable parent control');
  await opener.evaluate(element=>element.style.display='');await opener.dispose();
  await page.keyboard.press('Escape');await settings.waitFor({state:'detached'});
  console.log('Modal accessibility passed: add, OPML, tags, archives, settings, nested JSON; Tab/Shift+Tab, IME Escape, restoration, visible focus, reduced motion and 360/480/800/1200px source tabs');
}finally{await application?.close();await new Promise(resolve=>fixture.close(resolve));rmSync(data,{recursive:true,force:true});}


