import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';

const output=process.env.RIVU_ARTICLE_IMAGES_RESULT;assert.ok(output&&!existsSync(output));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-article-images-'));
const urls=[1,2,3].map(n=>`https://example.invalid/lazy-${n}.png`);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l3sAAAAASUVORK5CYII=','base64');
mkdirSync(join(directory,'cache','images'),{recursive:true});
const db=new RivuDatabase(join(directory,'rivu.db'));
try{
 const feed=db.addFeed({title:'Lazy image fixture',url:'https://example.invalid/feed',fetchInterval:0});
 const gap=Array.from({length:100},(_,i)=>`<p>Local reading paragraph ${i} ${'spaced content '.repeat(12)}</p>`).join('');
 db.addEntries(feed.id,[{title:'Viewport image fixture',url:'https://example.invalid/article',hash:'lazy',content:urls.map(url=>`<img width="600" src="${url}">${gap}`).join(''),media:urls.map(url=>({kind:'image',url,mime:'image/png',source:'body',title:'Viewport gallery fixture'}))}]);
 for(const url of urls){const name=createHash('sha256').update(url).digest('hex')+'.png';writeFileSync(join(directory,'cache','images',name),png);db.db.prepare('INSERT INTO cached_images(url,file_name,mime,bytes,saved_at,last_accessed_at) VALUES (?,?,?,?,?,?)').run(url,name,'image/png',png.length,'2000','2000');}
}finally{db.close();}
let app;
async function revokedImageStatus(page,url){
 const response=page.waitForResponse(reply=>reply.url()===url,{timeout:10000});
 const failed=await page.evaluate(url=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(false);image.onerror=()=>resolve(true);image.src=url;}),url);
 assert.equal(failed,true,'revoked capability cannot decode another image');return (await response).status();
}
try{
 app=await electron.launch({executablePath:resolve(process.env.RIVU_TEST_EXE),args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await app.evaluate(({session})=>{globalThis.__lazyRequests=[];session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(details.url.startsWith('rivu-image:'))globalThis.__lazyRequests.push(new URL(details.url).searchParams.get('url'));callback({});});});
 await page.locator('.entry-row').first().click();
 const image=n=>page.locator(`.rich-body img[data-rivu-url="${urls[n]}"]`);
 await image(0).waitFor();await page.waitForFunction(url=>{const i=document.querySelector(`.rich-body img[data-rivu-url="${url}"]`);return i?.naturalWidth===1&&i.complete;},urls[0]);
 const initialBox=await image(0).evaluate(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height}));
 assert.ok(initialBox.width>100);assert.ok(Math.abs(initialBox.width-initialBox.height)<1);
 const snapshot=()=>app.evaluate(()=>[...globalThis.__lazyRequests]);
 const initial=await snapshot();assert.ok(initial.includes(urls[0]));assert.ok(!initial.includes(urls[1])&&!initial.includes(urls[2]));
 await page.evaluate(()=>window.dispatchEvent(new Event('rivu-image-cache-updated')));
 await page.waitForFunction(url=>{const i=document.querySelector(`.rich-body img[data-rivu-url="${url}"]`);return i?.naturalWidth===1&&i.complete;},urls[0]);
 await page.waitForTimeout(500);const refreshed=await snapshot();assert.ok(!refreshed.includes(urls[1])&&!refreshed.includes(urls[2]));assert.ok(refreshed.length>initial.length);
 const oldSource=await image(0).getAttribute('src');
 await image(2).scrollIntoViewIfNeeded();await page.waitForFunction(url=>{const i=document.querySelector(`.rich-body img[data-rivu-url="${url}"]`);return i?.naturalWidth===1&&i.complete;},urls[2]);
 await page.waitForFunction(url=>!document.querySelector(`.rich-body img[data-rivu-url="${url}"]`)?.hasAttribute('src'),urls[0]);
 const suspendedBox=await image(0).evaluate(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height}));
 assert.ok(Math.abs(suspendedBox.width-initialBox.width)<1&&Math.abs(suspendedBox.height-initialBox.height)<1,'offscreen release must preserve the responsive image box');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).setContentSize(960,900));
 await page.waitForFunction(url=>document.querySelector(`.rich-body img[data-rivu-url="${url}"]`).getBoundingClientRect().width<600,urls[0]);
 const narrowBox=await image(0).evaluate(i=>({width:i.getBoundingClientRect().width,height:i.getBoundingClientRect().height}));assert.ok(narrowBox.width>0&&Math.abs(narrowBox.width-narrowBox.height)<1,'released image keeps its ratio after actual window resize');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/index.html')).setContentSize(1440,900));
 await page.waitForFunction(url=>document.querySelector(`.rich-body img[data-rivu-url="${url}"]`).getBoundingClientRect().width===600,urls[0]);
 const revoked=await revokedImageStatus(page,oldSource);assert.equal(revoked,503);
 await image(0).scrollIntoViewIfNeeded();await page.waitForFunction(url=>{const i=document.querySelector(`.rich-body img[data-rivu-url="${url}"]`);return i?.naturalWidth===1&&i.complete;},urls[0]);
 assert.notEqual(await image(0).getAttribute('src'),oldSource,'reentry requires a fresh independent capability');
 await page.waitForFunction(url=>!document.querySelector(`.rich-body img[data-rivu-url="${url}"]`)?.hasAttribute('src'),urls[2]);
 await page.locator('.entry-media summary').click();
 const gallery=page.locator('.media-gallery img').first();await gallery.scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>{const i=document.querySelector('.media-gallery img');return i?.naturalWidth===1&&i.complete;});
 const gallerySource=await gallery.getAttribute('src'),galleryHeight=await page.locator('.media-image-frame').first().evaluate(e=>e.getBoundingClientRect().height);assert.equal(galleryHeight,140);
 await image(2).scrollIntoViewIfNeeded();await page.waitForFunction(()=>!document.querySelector('.media-gallery img')?.hasAttribute('src'));
 const suspendedGalleryHeight=await page.locator('.media-image-frame').first().evaluate(e=>e.getBoundingClientRect().height);assert.equal(suspendedGalleryHeight,galleryHeight);
 assert.equal(await revokedImageStatus(page,gallerySource),503);
 await gallery.scrollIntoViewIfNeeded();await page.waitForFunction(()=>{const i=document.querySelector('.media-gallery img');return i?.naturalWidth===1&&i.complete;});assert.notEqual(await gallery.getAttribute('src'),gallerySource);
 const requests=await snapshot();await app.close();app=undefined;
 writeFileSync(output,JSON.stringify({status:'PASS',directory,executablePath:resolve(process.env.RIVU_TEST_EXE),initial,refreshed,requests,initialBox,suspendedBox,narrowBox,oldCapabilityStatus:revoked,freshCapabilityOnReentry:true,galleryHeight,suspendedGalleryHeight,galleryReentryAndRevocation:true,scope:'Packaged RichArticle and gallery, actual Chromium IntersectionObserver, scroll, window resize and preserved image boxes. Old per-consumer URIs revoked, fresh reentry URIs; synthetic cached PNGs, not physical60FPS, GPU resource reclamation or8MiB100ms acceptance'},null,2));console.log('PASS packaged article lazy refresh and real scroll');
}finally{await app?.close();console.log('Fixture:',directory);}
