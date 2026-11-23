import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-external-desktop-')),scope=relative(resolve(tmpdir()),resolve(directory));
assert.ok(scope.startsWith('rivu-external-desktop-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const hits=[];
const origin=createServer((req,res)=>{
  if(req.url.startsWith('/opened'))hits.push({url:req.url,userAgent:req.headers['user-agent'],destination:req.headers['sec-fetch-dest']});
  res.setHeader('cache-control','no-store');res.setHeader('content-type','text/html; charset=utf-8');
  res.end('<!doctype html><title>Rivu local open test</title><p>本地打开验证已完成。</p><script>setTimeout(()=>window.close(),1000)</script>');
});await new Promise(r=>origin.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${origin.address().port}/opened`,db=new RivuDatabase(join(directory,'rivu.db'));
const feed=db.addFeed({title:'Local',url:'https://example.invalid/feed',fetchInterval:0});
db.addEntries(feed.id,[{title:'External fixture',url,content:`<p>Local article <a href="${url}?body">Body link</a></p>`,hash:'external',media:[{kind:'audio',url:url+'?audio',mime:'audio/mpeg',source:'enclosure',title:'Audio fixture'}]},{title:'Footer fixture',url:url+'?footer',content:'<p>Footer browser receipt.</p>',hash:'footer'}]);
const initialId=db.entries().find(row=>row.title==='External fixture').id,footerId=db.entries().find(row=>row.title==='Footer fixture').id;db.close();
let app;const pageErrors=[];
try{
  app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
  let page;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(page);page.on('pageerror',error=>pageErrors.push(error.message));
  await page.locator(`.entry-row[data-entry-id="${initialId}"]`).click();await page.waitForFunction(()=>document.querySelector('.reader-content h1')?.textContent==='External fixture');
  await page.evaluate(()=>{window.__externalRejections=[];window.addEventListener('unhandledrejection',e=>window.__externalRejections.push(String(e.reason)));document.activeElement?.blur();});
  await app.evaluate(({shell})=>{globalThis.__externalOriginal=shell.openExternal;globalThis.__externalCalls=[];globalThis.__externalUnhandled=[];globalThis.__externalListener=reason=>globalThis.__externalUnhandled.push(String(reason));process.on('unhandledRejection',globalThis.__externalListener);shell.openExternal=async url=>{globalThis.__externalCalls.push(url);throw Error('fixture system failure');};});
  await page.keyboard.press('o');
  try{await page.locator('.toast[role="alert"]').getByText('无法打开链接，请检查默认浏览器设置或稍后重试。',{exact:true}).waitFor({timeout:3000});}
  catch(error){console.log(JSON.stringify({rejections:await page.evaluate(()=>window.__externalRejections),pageErrors}));throw error;}
  if(!process.env.RIVU_EXTERNAL_FAILURE_ONLY){
    const invalid=await page.evaluate(async()=>{const results=[];for(const value of ['file:///C:/fixture','javascript:alert(1)','data:text/html,test','http://','not a url',null]){try{await window.rivu.openExternal(value);results.push('accepted');}catch{results.push('rejected');}}return results;});
    assert.deepEqual(invalid,Array(6).fill('rejected'));assert.equal((await app.evaluate(()=>globalThis.__externalCalls)).length,1);
    for(const locator of [page.getByTitle('在浏览器打开',{exact:true}),page.getByRole('button',{name:'阅读原文 ↗',exact:true})]){
      await page.locator('.toast[role="alert"] button').click();await locator.click();
      await page.locator('.toast[role="alert"]').getByText('无法打开链接，请检查默认浏览器设置或稍后重试。',{exact:true}).waitFor();
    }
    await page.locator('.rich-body a').getByText('Body link',{exact:true}).click();
    await page.locator('.reader-original-body .article-error').getByText('无法打开链接，请检查默认浏览器设置或稍后重试。',{exact:true}).waitFor();
    await page.locator('.entry-media summary').click();await page.locator('.media-attachment').getByRole('button',{name:'打开媒体文件 ↗'}).click();
    await page.locator('.entry-media [role="alert"]').getByText('无法打开链接，请检查默认浏览器设置或稍后重试。',{exact:true}).waitFor();
    await page.locator('.media-attachment').getByRole('button',{name:'打开来源站 ↗'}).click();
    const callsEnd=Date.now()+3000;while((await app.evaluate(()=>globalThis.__externalCalls)).length<6){assert.ok(Date.now()<callsEnd);await new Promise(r=>setTimeout(r,10));}
    assert.equal((await app.evaluate(()=>globalThis.__externalCalls)).length,6);
    await page.locator('.toast[role="alert"] button').click();
    await page.evaluate(url=>window.open(url+'?window','_blank'),url);
    await page.locator('.toast[role="alert"]').getByText('无法打开链接，请检查默认浏览器设置或稍后重试。',{exact:true}).waitFor();
    assert.equal((await app.evaluate(()=>globalThis.__externalCalls)).length,7);
    assert.deepEqual(await app.evaluate(()=>globalThis.__externalUnhandled),[]);
    await page.locator('.article-save-options > summary').click();
    await page.getByRole('button',{name:'永久归档当前正文',exact:true}).click();await page.locator('.offline-status').getByText(/已永久归档/).waitFor();
    await page.getByRole('button',{name:'永久归档',exact:true}).click();await page.locator('.archive-item').filter({hasText:'External fixture'}).click();
    const archiveLink=page.locator('.archive-body a').getByText('Body link',{exact:true});await archiveLink.waitFor();
    page.once('dialog',dialog=>dialog.dismiss());await archiveLink.click();assert.equal((await app.evaluate(()=>globalThis.__externalCalls)).length,7);
    page.once('dialog',dialog=>dialog.accept());await archiveLink.click();await page.locator('.archive-modal [role="alert"]').getByText('无法打开链接，请检查默认浏览器设置或稍后重试。',{exact:true}).waitFor();
    assert.equal((await app.evaluate(()=>globalThis.__externalCalls)).length,8);await page.locator('.archive-modal').getByRole('button',{name:'关闭窗口',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.__externalRejections),[]);
    await app.evaluate(({shell})=>{shell.openExternal=globalThis.__externalOriginal;});
    const waitHit=async count=>{const end=Date.now()+15000;while(hits.length<count){assert.ok(Date.now()<end,'default browser did not request local page');await new Promise(r=>setTimeout(r,50));}};
    await page.bringToFront();await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('o');await waitHit(1);
    await page.bringToFront();await page.locator(`.entry-row[data-entry-id="${footerId}"]`).click();await page.waitForFunction(()=>document.querySelector('.reader-content h1')?.textContent==='Footer fixture');
    await page.getByRole('button',{name:'阅读原文 ↗',exact:true}).click();await waitHit(2);
    assert.deepEqual(hits.map(hit=>hit.url),['/opened','/opened?footer']);
    assert.ok(hits.every(hit=>hit.destination==='document'&&/Chrome|Firefox|Edg/.test(hit.userAgent||'')&&!hit.userAgent.includes('Electron/')),JSON.stringify(hits));
    assert.deepEqual(await page.evaluate(()=>window.__externalRejections),[]);
    assert.equal(app.windows().filter(p=>p.url().includes('/index.html')).length,1);
  }
  assert.deepEqual(pageErrors,[]);console.log(JSON.stringify({pageErrors,rejections:await page.evaluate(()=>window.__externalRejections),mainRejections:await app.evaluate(()=>globalThis.__externalUnhandled),actualBrowserHits:hits},null,2));
}finally{await app?.evaluate(({shell})=>{if(globalThis.__externalOriginal)shell.openExternal=globalThis.__externalOriginal;if(globalThis.__externalListener)process.removeListener('unhandledRejection',globalThis.__externalListener);}).catch(()=>{});await app?.close();await new Promise(r=>origin.close(r));rmSync(directory,{recursive:true,force:true});}
