import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {_electron as electron} from 'playwright-core';
const output=process.env.RIVU_MOTION_RESULT;assert.ok(output&&!existsSync(output));
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json','utf8'));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-motion-'));let app;
const report={status:'RUNNING',candidate,directory,cases:[],scope:'Actual packaged CSS animation and live reduced-motion preference on settings/add-feed dialogs; no physical frame-rate or full visual acceptance claim.'};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));save();
try{
 app=await electron.launch({executablePath:candidate.executablePath,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 for(const [name,button,selector] of [['settings','设置','.settings-dialog'],['add-feed','添加订阅','.dialog']]){
  await page.emulateMedia({reducedMotion:'no-preference'});await page.getByRole('button',{name:button,exact:true}).first().click();await page.locator(selector).waitFor();
  for(const reducedMotion of ['no-preference','reduce','no-preference']){
   await page.emulateMedia({reducedMotion});
   const result=await page.locator(selector).evaluate(root=>{
    const css=getComputedStyle(root),reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const unexpected=[];if(reduced)for(const element of [root,...root.querySelectorAll('*')])for(const pseudo of [null,'::before','::after']){const style=getComputedStyle(element,pseudo);if(style.animationName!=='none'||style.transitionDuration.split(',').some(v=>parseFloat(v)!==0)||style.scrollBehavior!=='auto')unexpected.push({tag:element.tagName,pseudo,animationName:style.animationName,transitionDuration:style.transitionDuration,scrollBehavior:style.scrollBehavior});}
    return {reduced,animationName:css.animationName,animationDuration:css.animationDuration,unexpected};
   });
   assert.equal(result.reduced,reducedMotion==='reduce');assert.equal(result.animationName,result.reduced?'none':'rivu-dialog-appear');if(!result.reduced)assert.equal(result.animationDuration,'0.12s');assert.deepEqual(result.unexpected,[]);
   report.cases.push({name,requested:reducedMotion,...result});save();
  }
  await page.keyboard.press('Escape');await page.locator(selector).waitFor({state:'hidden'});
 }
 const keyframes=await page.evaluate(()=>{const found=[];function inspect(rules){for(const rule of rules){if(rule.type===CSSRule.KEYFRAMES_RULE)found.push({name:rule.name,properties:[...new Set([...rule.cssRules].flatMap(frame=>[...frame.style]))]});else if(rule.cssRules)inspect(rule.cssRules);}}for(const sheet of document.styleSheets)inspect(sheet.cssRules);return found;});
 assert.deepEqual(keyframes,[{name:'rivu-dialog-appear',properties:['opacity']}]);report.keyframes=keyframes;report.status='PASS-scoped-reduced-motion';
}catch(error){report.status='FAIL';report.error=String(error);throw error;}
finally{if(app)await app.close();save();}
console.log(report.status);
