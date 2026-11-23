import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-reading-contrast-')),scope=relative(resolve(tmpdir()),resolve(directory));
assert.ok(scope.startsWith('rivu-reading-contrast-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const db=new RivuDatabase(join(directory,'rivu.db'));
for(const [name,failure,enabled] of [['Healthy',0,1],['Retrying',1,1],['Error',5,1],['Paused',0,0]]){
  const feed=db.addFeed({title:name,url:`https://example.invalid/${name}`,fetchInterval:0});
  db.db.prepare('UPDATE feeds SET failure_count=?,enabled=? WHERE id=?').run(failure,enabled,feed.id);
  if(name==='Healthy')db.addEntries(feed.id,[{title:'Unread fixture',content:'<p>Readable timeline summary.</p>',author:'Local author',hash:'unread'},{title:'Read fixture',content:'<p>Readable saved summary.</p>',author:'Local author',hash:'read'}]);
}
const read=db.entries().find(row=>row.title==='Read fixture');db.updateEntry(read.id,{read:true});db.close();
let app;const results=[],errors=[];
try{
  app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
  let page;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(page);page.on('pageerror',error=>errors.push(error.message));
  async function check(label,selector){
    const rows=await page.locator(selector).evaluateAll(elements=>{
      const rgba=value=>{const parts=value.match(/[\d.]+/g)?.map(Number);if(!parts||parts.length<3)throw Error('Unsupported color '+value);return [...parts.slice(0,3),parts[3]??1];};
      const over=(front,back)=>front.slice(0,3).map((v,i)=>v*front[3]+back[i]*(1-front[3]));
      const luminance=color=>color.map(c=>{const v=c/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
      return elements.filter(e=>e.getClientRects().length&&e.textContent.trim()).map(e=>{
        const chain=[];for(let p=e;p;p=p.parentElement)chain.push(p);
        let background=[255,255,255];
        for(const p of chain.reverse()){const style=getComputedStyle(p);if(style.backgroundImage!=='none'||Number(style.opacity)!==1)throw Error('Uncovered compositing case');background=over(rgba(style.backgroundColor),background);}
        const color=getComputedStyle(e).color,foreground=over(rgba(color),background),a=luminance(foreground),b=luminance(background);
        return {text:e.textContent.trim().slice(0,80),color,background,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)};
      });
    });
    assert.ok(rows.length,label+' must cover actual text');results.push({label,rows});
  }
  for(const theme of ['light','dark'])for(const density of ['standard','comfortable','compact']){
    await page.evaluate(value=>window.rivu.request('PATCH','/api/reading/settings',value),{theme,density});await page.reload();
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await page.locator('.entry-row').first().waitFor();
    await page.getByRole('button',{name:'全部',exact:true}).click();await page.locator(`.entry-row[data-entry-id="${read.id}"]`).waitFor();
    assert.equal(await page.locator('.entry-row').count(),2);
    const row=page.locator(`.entry-row[data-entry-id="${read.id}"]`);
    await check(`${theme}/${density}/resting`,'.entry-row time,.entry-row .source,.entry-row strong');
    if(density==='compact')assert.equal(await page.locator('.entry-row p').count(),0);else await check(`${theme}/${density}/snippet`,'.entry-row p');
    await row.hover();await check(`${theme}/${density}/hover`,'.entry-row time,.entry-row strong.read');
    await row.click();
    try{await page.waitForFunction(()=>document.querySelector('.reader-content h1')?.textContent==='Read fixture',{},{timeout:10000});}
    catch(error){console.log(JSON.stringify({theme,density,errors,view:await page.evaluate(()=>({headings:[...document.querySelectorAll('h1')].map(e=>e.textContent),reader:document.querySelector('.reader')?.textContent,rows:[...document.querySelectorAll('.entry-row')].map(e=>({id:e.dataset.entryId,text:e.textContent}))}))}));throw error;}
    await check(`${theme}/${density}/selected`,'.entry-row.selected time,.entry-row.selected .source,.entry-row.selected strong.read');
    if(density!=='compact')await check(`${theme}/${density}/selected-snippet`,'.entry-row.selected p');
    await check(`${theme}/${density}/reader`,'.reader-meta,.reader-kicker');
    if(density==='standard'){
      if(process.env.RIVU_TEST_SCREENSHOT_DIR){mkdirSync(process.env.RIVU_TEST_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.RIVU_TEST_SCREENSHOT_DIR,`${theme}-reading.png`)});}
      await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'订阅',exact:true}).click();
      await page.waitForTimeout(150);
      for(const health of ['healthy','retrying','error','paused'])await check(`${theme}/health/${health}`,`.feed-health.${health}`);
      await check(`${theme}/feed-detail`,'.feed-setting small');
    }
  }
  console.log(JSON.stringify({results,pageErrors:errors},null,2));assert.deepEqual(errors,[]);
  const failures=results.flatMap(result=>result.rows.filter(row=>row.ratio<4.5).map(row=>({...row,label:result.label})));
  assert.deepEqual(failures,[],'small text must have contrast >=4.5 against its rendered background');
}finally{await app?.close();rmSync(directory,{recursive:true,force:true});}
