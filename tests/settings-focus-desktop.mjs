import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-settings-focus-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-settings-focus-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const db=new RivuDatabase(join(directory,'rivu.db'));db.addFeed({title:'Keyboard source',url:'https://fixture.invalid/feed',fetchInterval:0});db.close();let app;const rows=[],errors=[];
const output=process.env.RIVU_TEST_SCREENSHOT_DIR?resolve(process.env.RIVU_TEST_SCREENSHOT_DIR):null;if(output)mkdirSync(output,{recursive:true});
function measureFocus(){
 const element=document.activeElement,style=getComputedStyle(element),color=value=>{const values=value.match(/[\d.]+/g)?.map(Number)||[0,0,0];return [...values.slice(0,3),values[3]??1];};
 const blend=(foreground,background)=>foreground.slice(0,3).map((value,index)=>value*foreground[3]+background[index]*(1-foreground[3]));
 const luminance=rgb=>rgb.map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
 const ancestors=[];for(let current=parseFloat(style.outlineOffset)<0?element:element.parentElement;current;current=current.parentElement)ancestors.push(current);
 let background=[255,255,255];for(const ancestor of ancestors.reverse())background=blend(color(getComputedStyle(ancestor).backgroundColor),background);
 const nav=element.closest('.settings-navigation'),box=element.getBoundingClientRect(),clip=nav?.getBoundingClientRect(),extent=Math.max(0,parseFloat(style.outlineOffset)+parseFloat(style.outlineWidth)),clipped=!!(clip&&(box.left-extent<clip.left-0.01||box.right+extent>clip.right+0.01||box.top-extent<clip.top-0.01||box.bottom+extent>clip.bottom+0.01));const ink=blend(color(style.outlineColor),background),a=luminance(ink),b=luminance(background),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
 return {tag:element.tagName,type:element.getAttribute('type'),id:element.id,class:element.className,label:element.getAttribute('aria-label')||element.textContent?.trim().slice(0,45)||element.getAttribute('placeholder')||element.closest('label')?.textContent.trim().slice(0,60),currentNavigation:document.querySelector('.settings-navigation [aria-current]')?.textContent.trim(),navigation:!!element.closest('.settings-navigation'),visible:element.matches(':focus-visible')||element.matches('input[type=date]:focus-within'),indicatorBounds:[box.left-extent,box.right+extent,box.top-extent,box.bottom+extent],navigationBounds:clip?[clip.left,clip.right,clip.top,clip.bottom]:null,pseudoFocusVisible:element.matches(':focus-visible'),clipped,outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth),outlineOffset:parseFloat(style.outlineOffset),outlineColor:style.outlineColor,background,ratio,inside:!!element.closest('[role=dialog]')};
}
try{
 app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});let page;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);page.on('pageerror',e=>errors.push(e.message));
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>window.rivu.request('PATCH','/api/reading/settings',{theme,uiFontSize:'large'}),theme);await page.reload();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
  for(const width of [360,800,1200]){
   await page.setViewportSize({width,height:800});await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'设置',exact:true});await dialog.waitFor();await dialog.evaluate(element=>Promise.all(element.getAnimations().map(animation=>animation.finished.catch(()=>{}))));await page.waitForFunction(()=>{const button=[...document.querySelectorAll('#settings-ai button')].find(element=>element.textContent?.trim()==='保存配置');return button&&!button.disabled;});
   const close=dialog.getByRole('button',{name:'关闭设置',exact:true});await close.focus();let completed=false,navCount=0;
   for(let index=0;index<180;index++){
    await page.keyboard.press('Tab');if(await close.evaluate(element=>element===document.activeElement)){rows.push({theme,width,...await page.evaluate(measureFocus)});completed=true;break;}
    const row={theme,width,...await page.evaluate(measureFocus)};rows.push(row);if(output&&width===360&&row.type==='date'&&!row.pseudoFocusVisible)await page.screenshot({path:join(output,`${theme}-${width}-weak-${index}.png`)});assert.equal(row.inside,true,'native Tab stays in settings');if(row.navigation){assert.equal(row.currentNavigation,'常规','focusing a category does not activate it or move the content section');navCount++;if(output&&navCount===1)await page.screenshot({path:join(output,`${theme}-${width}-first-nav.png`)});}
   }
   assert.equal(completed,true,'native keyboard cycle reaches the close button again');assert.equal(navCount,9,'all nine settings categories are keyboard reachable');await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  }
 }
 const failures=rows.filter(row=>!row.visible||row.outlineStyle!=='solid'||row.outlineWidth<2||row.ratio<3||row.clipped);if(output)writeFileSync(join(output,'measurements.json'),JSON.stringify({rows,failures,errors},null,2));console.log(JSON.stringify({checks:rows.length,failures,errors},null,2));assert.deepEqual(errors,[]);assert.equal(failures.length,0,'settings keyboard focus has a visible two-pixel outline with contrast >= 3');
}finally{await app?.close();rmSync(directory,{recursive:true,force:true});}






