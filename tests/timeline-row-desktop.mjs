import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {_electron as electron} from 'playwright-core';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-timeline-row-')),cleanup=relative(resolve(tmpdir()),resolve(directory));assert.ok(cleanup.startsWith('rivu-timeline-row-')&&!cleanup.startsWith('..')&&!isAbsolute(cleanup));
let application,beacons=0,base;
const descriptions=['plain &amp; text','<p>段落一</p><div>段落二<br>换行</div>','<script>hidden</script><style>hidden</style><noscript>hidden</noscript><p>安全内容</p>','<title>隐藏标题</title><p>正文</p>','<table><tr><td>单元格</td></tr></table><blockquote>引用</blockquote>','<p><!--comment-->Text <strong>bold</strong></p>','<form><input value="x"><button>按钮文字</button></form>内容','<head><title>隐藏</title></head><body><p>可见</p></body>','<h1>小标题</h1><ul><li>第一项</li><li>第二项</li></ul>','<div><p>嵌套</p></div>','<p>Emoji 😀 &lt;safe&gt;</p>','<img src="BEACON"><iframe src="BEACON"></iframe><p>图片说明</p>'];
const fixture=createServer((req,res)=>{if(req.url==='/beacon'){beacons++;res.end('beacon');return;}res.setHeader('content-type','application/rss+xml');res.end(`<rss version="2.0"><channel><title>Row fixture</title>${Array.from({length:48},(_,n)=>descriptions[n%descriptions.length]).map((html,n)=>`<item><guid>case-${n}</guid><title>Case ${n}</title><pubDate>${new Date(Date.UTC(2026,8,28)+n*1000).toUTCString()}</pubDate><description><![CDATA[${html.replaceAll('BEACON',base+'/beacon')}]]></description></item>`).join('')}</channel></rss>`);});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${fixture.address().port}`;
try{
  application=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
  let page;const end=Date.now()+30000;while(Date.now()<end){page=application.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);
  await page.evaluate(base=>window.rivu.request('POST','/api/feeds',{url:base+'/feed',allowPrivate:true,fetchInterval:0}),base);await page.reload();await page.locator('.entry-row').first().waitFor();
  const entries=await page.evaluate(()=>window.rivu.request('GET','/api/entries?limit=100'));
  const before=await page.locator('.entry-row').evaluateAll(rows=>rows.map(row=>({title:row.querySelector('strong').textContent,text:row.querySelector('p')?.textContent,date:row.querySelector('time').textContent})));
  await page.evaluate(()=>{
    const counters={parsers:0,templates:0,formatters:0},Parser=DOMParser,Formatter=Intl.DateTimeFormat,create=document.createElement.bind(document);
    window.DOMParser=class extends Parser{parseFromString(...args){counters.parsers++;return super.parseFromString(...args);}};
    Intl.DateTimeFormat=function(...args){counters.formatters++;return new Formatter(...args);};Intl.DateTimeFormat.prototype=Formatter.prototype;
    document.createElement=function(name,...args){if(name.toLowerCase()==='template')counters.templates++;return create(name,...args);};window.rowRenderCounters=counters;
  });
  await page.getByRole('button',{name:'批量操作',exact:true}).click();await page.getByRole('button',{name:'完成选择',exact:true}).click();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const counters=await page.evaluate(()=>({...window.rowRenderCounters})),after=await page.locator('.entry-row').evaluateAll(rows=>rows.map(row=>({title:row.querySelector('strong').textContent,text:row.querySelector('p')?.textContent,date:row.querySelector('time').textContent})));
  assert.deepEqual(after,before,'selection controls must not change snippets or dates');
  const all=new Map(after.map(row=>[row.title,row]));await page.locator('.entry-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  for(const row of await page.locator('.entry-row').evaluateAll(rows=>rows.map(row=>({title:row.querySelector('strong').textContent,text:row.querySelector('p')?.textContent,date:row.querySelector('time').textContent}))))all.set(row.title,row);
  assert.equal(new Set([...all.keys()].map(title=>Number(title.split(' ')[1])%descriptions.length)).size,descriptions.length,'text parity must cover every HTML case, including offscreen rows');
  for(const row of all.values()){const entry=entries.find(e=>e.title===row.title);const expected=await page.evaluate(html=>{const doc=new DOMParser().parseFromString(html.replace(/<img[^>]*>|<iframe[^>]*><\/iframe>/g,''),'text/html');doc.querySelectorAll('script,style,noscript').forEach(e=>e.remove());doc.querySelectorAll('p,div,br,li,h1,h2,h3,blockquote').forEach(e=>e.append('\n'));return (doc.body.textContent||'').replace(/\n{3,}/g,'\n\n').trim().slice(0,95);},entry.description||entry.content||'');assert.equal(row.text,expected,row.title);}
  console.log(JSON.stringify({rows:after.length,counters,beacons}));assert.equal(counters.parsers,0,'unchanged rows must not parse another HTML document');assert.equal(counters.templates,0,'unchanged snippets must reuse derived text');assert.ok(counters.formatters<=3,'only the parent timezone check may recreate a formatter');assert.equal(beacons,0,'timeline snippets must remain passive');
  const session=await page.context().newCDPSession(page);await session.send('Emulation.setTimezoneOverride',{timezoneId:'America/New_York'});
  await page.getByRole('button',{name:'批量操作',exact:true}).click();
  const dates=await page.locator('.entry-row').evaluateAll(rows=>rows.map(row=>({title:row.querySelector('strong').textContent,date:row.querySelector('time').textContent})));
  for(const row of dates){const entry=entries.find(e=>e.title===row.title);const expected=await page.evaluate(date=>new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(date)),entry.published_at||entry.fetched_at);assert.equal(row.date,expected,'timezone changes must invalidate cached dates');}
  assert.ok(dates.some(row=>row.date!==all.get(row.title).date));console.log('Timeline row reuse, text parity, passive snippets and timezone invalidation passed');
  await page.evaluate(()=>window.rivu.request('PATCH','/api/reading/settings',{density:'compact'}));await page.reload();await page.locator('.entry-row.compact').first().waitFor();
  assert.equal(await page.locator('.entry-row p').count(),0);
  await page.locator('.entry-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);await page.getByText('Case 0',{exact:true}).waitFor();
  const compactBefore=await page.locator('.entry-row').evaluateAll(rows=>rows.map(row=>row.dataset.entryId));
  await page.evaluate(()=>{const create=document.createElement.bind(document),Parser=DOMParser;window.compactTemplates=0;window.compactDocuments=0;document.createElement=function(name,...args){if(name.toLowerCase()==='template')window.compactTemplates++;return create(name,...args);};window.DOMParser=class extends Parser{parseFromString(...args){window.compactDocuments++;return super.parseFromString(...args);}};});
  await page.locator('.entry-scroll').evaluate(element=>element.scrollTop=0);await page.getByText('Case 47',{exact:true}).waitFor();
  const compactAfter=await page.locator('.entry-row').evaluateAll(rows=>rows.map(row=>row.dataset.entryId));assert.ok(compactAfter.some(id=>!compactBefore.includes(id)),'compact scroll must mount previously offscreen rows');
  assert.equal(await page.evaluate(()=>window.compactTemplates+window.compactDocuments),0,'compact rows must not derive invisible snippets');console.log('Compact rows skip hidden snippet work');
}finally{await application?.close();await new Promise(r=>fixture.close(r));rmSync(directory,{recursive:true,force:true});}
