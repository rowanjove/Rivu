import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-html-view-')),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-html-view-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');let imageRequests=0,otherRequests=0;
const origin=createServer((req,res)=>{if(req.url==='/image.png'){imageRequests++;res.setHeader('content-type','image/png');res.end(png);}else{otherRequests++;res.end('beacon');}});await new Promise(r=>origin.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${origin.address().port}`,assetId=randomUUID(),archiveId=randomUUID(),versionId=randomUUID();
const source=`  
<div><style>.sidebar{opacity:.37!important}</style><h2>Safe heading 中文</h2><p class="reader-meta" id="settings-reading" data-theme="dark">Safe paragraph &amp; emoji 😀.</p><blockquote>Quoted text</blockquote><table><tr><td>Cell A</td><td>Cell B</td></tr></table><pre><code>&lt;script&gt;literal code&lt;/script&gt;</code></pre><pre>

  Literal newline &lt;code&gt;
</pre><form action="${base}/post"><input name="token"><button>Source button text</button></form><a href="/linked">Safe link</a><img src="${base}/image.png" alt="Valid image"><img data-rivu-url="${base}/forged" data-archive-asset="forged" alt="Forged marker"><video poster="${base}/poster"><source src="${base}/media"></video></div>`;
const db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'HTML fixture',url:base+'/feed',allowPrivate:true,fetchInterval:0});db.addEntries(feed.id,[{title:'HTML fixture article',url:base+'/article',content:source,hash:'html'}]);const id=db.entries()[0].id;
const now=new Date().toISOString();db.db.prepare('INSERT INTO permanent_archives(id,source_entry_id,feed_id,feed_title,title,url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(archiveId,id,feed.id,feed.title,'HTML fixture archive',base+'/article',now,now);
db.db.prepare('INSERT INTO archive_versions(id,archive_id,content_hash,body_html,created_at) VALUES (?,?,?,?,?)').run(versionId,archiveId,createHash('sha256').update(source).digest('hex'),source,now);
db.db.prepare('INSERT INTO archive_assets(id,archive_id,version_id,kind,url,mime,bytes,data) VALUES (?,?,?,?,?,?,?,?)').run(assetId,archiveId,versionId,'image',base+'/image.png','image/png',png.length,png);db.close();
let app;const results=[],errors=[];
try{
  app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});let page;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);page.on('pageerror',error=>errors.push(error.message));
  const inspect=async selector=>page.locator(selector).evaluate(root=>({sidebarOpacity:getComputedStyle(document.querySelector('.sidebar')).opacity,styleCount:root.querySelectorAll('style').length,interactive:root.querySelectorAll('form,input,button,select,textarea,iframe,object,embed,video,audio,source').length,sourceAttributes:[...root.querySelectorAll('*')].flatMap(e=>[...e.attributes].filter(a=>['class','id','name','style','data-theme'].includes(a.name)).map(a=>a.name)),readerMarkers:[...root.querySelectorAll('[data-rivu-url]')].map(e=>e.getAttribute('data-rivu-url')),archiveMarkers:[...root.querySelectorAll('[data-archive-asset]')].map(e=>e.getAttribute('data-archive-asset')),text:root.textContent,leadingText:root.firstChild?.nodeType===3?root.firstChild.textContent:null,preTexts:[...root.querySelectorAll('pre')].map(e=>e.textContent),href:root.querySelector('a').getAttribute('href'),cells:root.querySelectorAll('td').length}));
  await page.locator(`.entry-row[data-entry-id="${id}"]`).click();await page.locator('.reader-original-body .rich-body h2').waitFor();
  await page.waitForFunction(()=>document.querySelector('.reader-original-body img[alt="Valid image"]')?.naturalWidth===1);results.push({kind:'reader',...await inspect('.reader-original-body .rich-body')});
  await page.getByRole('button',{name:'全部',exact:true}).click();await page.locator('.reader-content').waitFor({state:'detached'});assert.equal(await page.locator('.sidebar').evaluate(e=>getComputedStyle(e).opacity),'1');
  await page.getByRole('button',{name:'永久归档',exact:true}).click();await page.locator('.archive-item').filter({hasText:'HTML fixture archive'}).click();await page.locator('.archive-body h2').waitFor();
  await page.waitForFunction(()=>document.querySelector('.archive-body img[alt="Valid image"]')?.naturalWidth===1);results.push({kind:'archive',...await inspect('.archive-body')});
  console.log(JSON.stringify({results,errors,imageRequests,otherRequests},null,2));
  for(const row of results){assert.equal(row.leadingText,'  \n');assert.deepEqual(row.preTexts,['<script>literal code</script>','\n  Literal newline <code>\n']);assert.equal(row.sidebarOpacity,'1');assert.equal(row.styleCount,0);assert.equal(row.interactive,0);assert.deepEqual(row.sourceAttributes,[]);assert.equal(row.href,base+'/linked');assert.equal(row.cells,2);for(const text of ['Safe heading 中文','Safe paragraph & emoji 😀.','Quoted text','Cell A','<script>literal code</script>'])assert.ok(row.text.includes(text));assert.ok(!row.text.includes('opacity'));}
  assert.deepEqual(results[0].readerMarkers,[base+'/image.png']);assert.deepEqual(results[0].archiveMarkers,[]);assert.deepEqual(results[1].readerMarkers,[]);assert.deepEqual(results[1].archiveMarkers,[assetId]);assert.equal(otherRequests,0);assert.deepEqual(errors,[]);
  await app.close();app=null;const check=new RivuDatabase(join(directory,'rivu.db'));try{assert.equal(check.entry(id).content,source);assert.equal(check.db.prepare('SELECT body_html FROM archive_versions WHERE id=?').get(versionId).body_html,source);}finally{check.close();}
}finally{await app?.close();await new Promise(r=>origin.close(r));rmSync(directory,{recursive:true,force:true});}
