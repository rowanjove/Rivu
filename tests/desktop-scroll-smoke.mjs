import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const directory=mkdtempSync(join(tmpdir(),'rivu-scroll-'));
const executable=resolve(process.env.RIVU_TEST_EXE||'release/win-unpacked/Rivu.exe');
let extra=0,application;
const source=createServer((_request,response)=>{
  const items=Array.from({length:350+extra},(_,index)=>{
    const number=350+extra-index;
    return `<item><title>深页文章 ${number}</title><guid>scroll-${number}</guid><pubDate>${new Date(Date.UTC(2026,8,28,0,0,0)+number*1000).toUTCString()}</pubDate><description>正文 ${number}</description></item>`;
  }).join('');
  response.setHeader('content-type','application/rss+xml; charset=utf-8');
  response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>深页测试来源</title><link>http://127.0.0.1:${source.address().port}</link>${items}</channel></rss>`);
});
function visibleTitle(){
  const viewport=document.querySelector('.entry-scroll')?.getBoundingClientRect();
  if(!viewport)return null;
  return [...document.querySelectorAll('.entry-row')].filter(row=>{const box=row.getBoundingClientRect();return box.bottom>viewport.top&&box.top<viewport.bottom;}).sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0]?.querySelector('strong')?.textContent||null;
}
async function mainWindow(application){
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const page=application.windows().find(item=>item.url().includes('/index.html'));
    if(page)return page;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('启动后未打开阅读窗口');
}
try{
  await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
  application=await electron.launch({executablePath:executable,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
  const page=await mainWindow(application);
  await page.getByText('Rivu',{exact:true}).first().waitFor({timeout:30000});
  await page.getByRole('button',{name:'添加订阅'}).first().click();
  await page.getByPlaceholder('https://example.com').fill(`http://127.0.0.1:${source.address().port}/feed`);
  await page.getByRole('checkbox',{name:/允许此订阅访问 localhost/}).check();
  await page.getByRole('button',{name:'检测',exact:true}).click();
  await page.getByRole('button',{name:'订阅',exact:true}).click();
  await page.getByText('深页文章 350').first().waitFor({timeout:30000});
  for(let attempt=0;attempt<8;attempt++){
    await page.locator('.entry-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});
    await page.waitForTimeout(350);
    if(Number((await page.evaluate(visibleTitle))?.match(/\d+$/)?.[0])<100)break;
  }
  const scroller=page.locator('.entry-scroll');
  const wheelStart=await scroller.evaluate(element=>element.scrollTop);
  await scroller.hover();
  await page.evaluate(()=>{
    const intervals=[],longTasks=[];let last=0,active=true;
    const tick=now=>{if(last)intervals.push(now-last);last=now;if(active)requestAnimationFrame(tick);};
    const observer=new PerformanceObserver(list=>{for(const item of list.getEntries())longTasks.push(item.duration);});
    try{observer.observe({entryTypes:['longtask']});}catch{/* Some runtimes do not expose long tasks. */}
    window.rivuWheelProbe={stop(){active=false;observer.disconnect();return {intervals,longTasks};}};
    requestAnimationFrame(tick);
  });
  for(let index=0;index<18;index++){await page.mouse.wheel(0,-120);await page.waitForTimeout(16);}
  await page.waitForTimeout(250);
  const probe=await page.evaluate(()=>window.rivuWheelProbe.stop());
  const wheelEnd=await scroller.evaluate(element=>element.scrollTop);
  assert.ok(wheelEnd<wheelStart,`鼠标滚轮未移动深页时间线：${wheelStart} → ${wheelEnd}`);
  assert.ok(probe.intervals.length>0,'连续滚轮期间没有采集到渲染帧');
  const frames=probe.intervals.toSorted((a,b)=>a-b),median=frames[Math.floor(frames.length/2)],p95=frames[Math.ceil(frames.length*.95)-1],max=frames.at(-1);
  const before=await page.evaluate(visibleTitle);
  assert.ok(before&&Number(before.match(/\d+$/)?.[0])<100,`未能滚动到第三页后：${before}`);
  extra=5;
  await page.getByTitle('刷新',{exact:true}).click();
  await page.getByRole('status').getByText('刷新完成，新增 5 篇文章').waitFor({timeout:30000});
  await page.waitForTimeout(1500);
  const after=await page.evaluate(visibleTitle);
  assert.equal(after,before,`深页刷新应保留可见锚点，原位置 ${before}，刷新后 ${after}`);
  assert.equal(await page.locator('.entry-row').count()<40,true,'虚拟列表不应同时渲染数百篇文章');
  await page.locator('.entry-row').filter({hasText:before}).first().click();
  await page.locator('.reader-content h1').getByText(before,{exact:true}).waitFor();
  extra=10;
  await page.getByTitle('刷新',{exact:true}).click();
  await page.getByRole('status').getByText('刷新完成，新增 5 篇文章').waitFor({timeout:30000});
  await page.waitForTimeout(1500);
  const afterRemoved=await page.evaluate(visibleTitle);
  assert.ok(Math.abs(Number(afterRemoved?.match(/\d+$/)?.[0])-Number(before.match(/\d+$/)?.[0]))<=1,`已读文章退出当前视图时应回到相邻文章：${before} → ${afterRemoved}`);
  assert.equal(await page.locator('.reader-content h1').textContent(),before,'深页刷新仍应保留正在阅读的文章');
  console.log(`Desktop deep-scroll refresh passed: wheel ${wheelStart}→${wheelEnd}px, ${before} retained, read-filter fallback ${afterRemoved}, 350→360 articles; ${frames.length} frame intervals, median ${median.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms, max ${max.toFixed(1)}ms, long tasks ${probe.longTasks.length} (Chromium frame callbacks, not display presentation)`);
}finally{
  if(application)await application.close();
  await new Promise(resolve=>source.close(resolve));
  assert.ok(directory.startsWith(join(tmpdir(),'rivu-scroll-')));
  rmSync(directory,{recursive:true,force:true});
}
