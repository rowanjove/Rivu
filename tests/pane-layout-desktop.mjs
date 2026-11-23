import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
import {_electron as electron} from 'playwright-core';
const output=process.env.RIVU_PANE_LAYOUT_RESULT;assert.ok(output&&!existsSync(output)&&process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-pane-layout-'));
const db=new RivuDatabase(join(directory,'rivu.db'));
try{
 const category=db.addCategory('设计与灵感'),feed=db.addFeed({title:'设计周刊',url:'https://example.invalid/layout',categoryId:category.id,fetchInterval:0});db.updateFeed(feed.id,{enabled:false});db.addTag('设计');
 db.addEntries(feed.id,Array.from({length:80},(_,index)=>({title:index===0?'留白与专注：让阅读回到内容本身':`设计手记 ${index+1}：在细节中寻找秩序`,hash:'layout-'+index,publishedAt:new Date(Date.UTC(2026,9,30,10,80-index)).toISOString(),description:'把常用工具留在手边，把更多空间还给文章。',content:'<h2>留白，是为了更好地阅读</h2>'+Array.from({length:70},(_,n)=>`<p>${n+1}. 让内容成为主角，减少界面的打扰。收起导航仍然能迅速切换来源，沉浸阅读保留舒适的行宽与稳定的位置。</p>`).join('')})));
}finally{db.close();}
let app,page,error;const checks={},screenshots=[];
async function capture(label){const path=resolve(output+'.'+label+'.png');assert.ok(!existsSync(path));await page.screenshot({path});screenshots.push({label,path});}
async function geometry(){return page.evaluate(()=>{
 const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
 return {sidebar:box('.sidebar'),list:box('.entry-panel'),reader:box('.reader-panel'),window:innerWidth};
});}
try{
 app=await electron.launch({executablePath:resolve(process.env.RIVU_TEST_EXE),args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 const end=Date.now()+60000;while(Date.now()<end){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.getByRole('button',{name:'全部',exact:true}).click();await page.locator('.entry-row').first().click();await page.locator('.reader-content h1').waitFor();
 checks.normal=await geometry();assert.equal(checks.normal.sidebar.width,220);assert.equal(checks.normal.list.width,440);await capture('normal');
 await page.getByRole('button',{name:'收起导航栏',exact:true}).click();await page.getByRole('button',{name:'收起文章列表',exact:true}).click();
 checks.compact=await geometry();assert.equal(checks.compact.sidebar.width,64);assert.equal(checks.compact.list.width,220);
 assert.ok(await page.getByRole('button',{name:'设计周刊',exact:true}).isVisible());assert.ok(await page.locator('.feed-nav>.source-icon-shell').isVisible());
 assert.equal(await page.locator('.entry-row p').first().isVisible(),false);await capture('compact');
 await page.evaluate(()=>{window.__layoutReader=document.querySelector('.reader-content');document.querySelector('.entry-scroll').scrollTop=900;window.__layoutReader.scrollTop=600;});
 const before=await page.evaluate(()=>({list:document.querySelector('.entry-scroll').scrollTop,title:document.querySelector('.reader-content h1').textContent}));
 await page.getByRole('button',{name:'沉浸阅读',exact:true}).click();
 checks.immersive=await geometry();assert.equal(checks.immersive.reader.width,checks.immersive.window);assert.equal(await page.getByRole('navigation').count(),0);
 assert.ok(await page.locator('.sidebar').evaluate(el=>el.inert));assert.equal(await page.locator('.sidebar').isVisible(),false);
 assert.ok(await page.evaluate(()=>document.querySelector('.reader-content')===window.__layoutReader));await capture('immersive');
 await page.getByTitle('标签',{exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 assert.ok(await page.getByRole('button',{name:'退出沉浸阅读',exact:true}).isVisible());
 await page.keyboard.press('Escape');assert.ok(await page.getByRole('button',{name:'沉浸阅读',exact:true}).isVisible());
 checks.restored=await page.evaluate(()=>({list:document.querySelector('.entry-scroll').scrollTop,title:document.querySelector('.reader-content h1').textContent,reader:document.querySelector('.reader-content').scrollTop}));
 assert.ok(Math.abs(checks.restored.list-before.list)<4);assert.equal(checks.restored.title,before.title);assert.ok(checks.restored.reader>100);
 await page.getByRole('button',{name:'沉浸阅读',exact:true}).click();await page.reload();await page.locator('.entry-row').first().waitFor();
 checks.reload=await page.evaluate(()=>({collapsed:document.querySelector('.app-shell').classList.contains('navigation-collapsed'),compact:document.querySelector('.app-shell').classList.contains('list-compact'),immersive:document.querySelector('.app-shell').classList.contains('is-immersive')}));
 assert.deepEqual(checks.reload,{collapsed:true,compact:true,immersive:false});
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('.settings-dialog label').filter({hasText:/^主题/}).locator('select').selectOption('dark');await page.getByRole('button',{name:'关闭设置',exact:true}).click();
 await page.locator('.entry-row').first().click();await page.locator('.reader-content h1').waitFor();await page.getByRole('button',{name:'沉浸阅读',exact:true}).click();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await capture('immersive-dark');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'展开导航栏',exact:true}).click();
 for(const width of [700,480]){
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).setSize(width,900),width);
  await page.waitForFunction(width=>innerWidth===width,width);
  const bounds=await page.evaluate(()=>({viewport:innerWidth,buttons:[...document.querySelectorAll('.reader-toolbar button')].filter(el=>el.getBoundingClientRect().width>0).map(el=>({title:el.title,x:el.getBoundingClientRect().x,right:el.getBoundingClientRect().right}))}));
  checks['width'+width]=bounds;assert.ok(bounds.buttons.every(b=>b.x>=0&&b.right<=bounds.viewport+1),'reader controls must stay reachable at width'+width);
  await page.getByRole('button',{name:'沉浸阅读',exact:true}).click();assert.equal((await geometry()).reader.width,width);await page.getByRole('button',{name:'退出沉浸阅读',exact:true}).click();
 }
}catch(cause){error=cause.message;}
finally{await app?.close();}
const report={recordedAt:new Date().toISOString(),status:error?'FAIL-pane-layout':'PASS-pane-layout',executablePath:resolve(process.env.RIVU_TEST_EXE),directory,checks,screenshots,error,scope:'Actual package UI geometry, persistence, same reader DOM, list scroll preservation, modal/Escape handling, light/dark screenshots and narrow controls. Not full PRD/performance or all display-scale acceptance.'};
writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.equal(report.status,'PASS-pane-layout');
