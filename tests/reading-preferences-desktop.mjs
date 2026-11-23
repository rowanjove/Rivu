import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createServer} from 'node:http';
import {deflateSync} from 'node:zlib';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-reading-prefs-')),scope=relative(resolve(tmpdir()),resolve(directory));
assert.ok(scope.startsWith('rivu-reading-prefs-')&&!scope.startsWith('..')&&!isAbsolute(scope));
function chunk(type,data){const name=Buffer.from(type),bytes=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,bytes,sum]);}
const header=Buffer.alloc(13);header.writeUInt32BE(1000,0);header.writeUInt32BE(160,4);header[8]=8;header[9]=2;
const pixels=Buffer.alloc(160*(1+1000*3),220);for(let y=0;y<160;y++)pixels[y*(1+1000*3)]=0;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const origin=createServer((req,res)=>{if(req.url==='/image.png'){res.setHeader('content-type','image/png');res.end(png);}else{res.setHeader('content-type','text/html');res.end('<p>Local fixture</p>');}});
await new Promise(r=>origin.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${origin.address().port}`;
const db=new RivuDatabase(join(directory,'rivu.db')),feed=db.addFeed({title:'Reading fixture',url:base+'/feed',fetchInterval:0,allowPrivate:true});
db.addEntries(feed.id,[{title:'Preferences fixture',url:base+'/article',content:`<p>Local paragraph for reading preferences.</p><img src="${base}/image.png" alt="Wide fixture"><p><a href="${base}/link">Local link</a></p>`,hash:'prefs'}]);const id=db.entries()[0].id;db.close();
let app,page;const results=[],typography=[],errors=[];
async function launch(){app=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});page=null;const end=Date.now()+30000;while(Date.now()<end){page=app.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'全部',exact:true}).click();await page.locator(`.entry-row[data-entry-id="${id}"]`).click();await page.locator('.rich-body p').first().waitFor();}
async function geometry(){await page.locator('.rich-body img').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.rich-body img')?.naturalWidth===1000);return page.evaluate(()=>{const reader=document.querySelector('.reader-content'),body=document.querySelector('.rich-body'),image=body.querySelector('img'),paragraph=body.querySelector('p'),r=reader.getBoundingClientRect(),b=body.getBoundingClientRect(),i=image.getBoundingClientRect(),s=getComputedStyle(paragraph);return {reader:{left:r.left,right:r.right,clientWidth:reader.clientWidth,scrollWidth:reader.scrollWidth},body:{left:b.left,right:b.right,width:b.width},image:{left:i.left,right:i.right,width:i.width},font:s.fontFamily,fontSize:parseFloat(s.fontSize),lineHeight:parseFloat(s.lineHeight)};});}
try{
  await launch();await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'阅读',exact:true}).click();
  const controls=page.locator('#settings-reading');
  for(const [label,value] of [['正文字体','serif'],['字号','20'],['行距','2'],['文章宽度','680'],['图片宽度','wide'],['正文链接','ask']])await controls.locator('label').filter({hasText:new RegExp('^'+label)}).locator('select').selectOption(value);
  await page.keyboard.press('Escape');await page.locator('.settings-dialog').waitFor({state:'detached'});
  const expected={font:'serif',fontSize:20,lineHeight:2,width:680,imageWidth:'wide',linkTarget:'ask'};
  await page.waitForFunction(async expected=>{const value=(await window.rivu.request('GET','/api/reading/settings')).preferences;return Object.entries(expected).every(([key,v])=>value[key]===v);},expected);
  await app.close();app=null;await launch();const saved=(await page.evaluate(()=>window.rivu.request('GET','/api/reading/settings'))).preferences;
  for(const [key,value] of Object.entries(expected))assert.equal(saved[key],value);
  const initial=await geometry();assert.equal(initial.fontSize,20);assert.equal(initial.lineHeight,40);assert.ok(initial.font.includes('Georgia'));
  await app.evaluate(({shell})=>{globalThis.__readingOriginal=shell.openExternal;globalThis.__readingLinks=[];shell.openExternal=async url=>{globalThis.__readingLinks.push(url);};});
  const link=page.locator('.rich-body a');page.once('dialog',dialog=>dialog.dismiss());await link.click();assert.equal((await app.evaluate(()=>globalThis.__readingLinks)).length,0);
  page.once('dialog',dialog=>dialog.accept());await link.click();
  const acceptedEnd=Date.now()+3000;while((await app.evaluate(()=>globalThis.__readingLinks)).length<1){assert.ok(Date.now()<acceptedEnd);await new Promise(r=>setTimeout(r,10));}
  assert.deepEqual(await app.evaluate(()=>globalThis.__readingLinks),[base+'/link']);
  for(const viewport of [480,680,800,1100,1600,1920])for(const width of [680,760,840])for(const imageWidth of ['column','wide']){
    const index=results.length,fontSize=[14,16,18,20][index%4],lineHeight=[1.6,1.8,2][index%3],font=index%2?'serif':'sans';
    await page.setViewportSize({width:viewport,height:900});await page.evaluate(value=>window.rivu.request('PATCH','/api/reading/settings',value),{width,imageWidth,fontSize,lineHeight,font,linkTarget:'external'});await page.reload();
    await page.getByRole('button',{name:'全部',exact:true}).click();await page.locator(`.entry-row[data-entry-id="${id}"]`).click();const value=await geometry();
    results.push({viewport,width,imageWidth,expected:{fontSize,lineHeight,font},...value});
  }
  for(const font of ['sans','serif'])for(const fontSize of [14,16,18,20])for(const lineHeight of [1.6,1.8,2]){
    await page.evaluate(value=>window.rivu.request('PATCH','/api/reading/settings',value),{font,fontSize,lineHeight,width:760,imageWidth:'column',linkTarget:'external'});await page.reload();
    await page.getByRole('button',{name:'全部',exact:true}).click();await page.locator(`.entry-row[data-entry-id="${id}"]`).click();const value=await geometry();
    typography.push({expected:{font,fontSize,lineHeight},...value});
  }
  const dialogs=[],onDialog=dialog=>{dialogs.push(dialog.type());void dialog.dismiss();};page.on('dialog',onDialog);
  await page.locator('.rich-body a').click();const directEnd=Date.now()+3000;while((await app.evaluate(()=>globalThis.__readingLinks)).length<2){assert.ok(Date.now()<directEnd);await new Promise(r=>setTimeout(r,10));}
  page.off('dialog',onDialog);assert.deepEqual(dialogs,[]);assert.deepEqual(await app.evaluate(()=>globalThis.__readingLinks),[base+'/link',base+'/link']);
  console.log(JSON.stringify({restartPreferences:saved,results,typography,pageErrors:errors},null,2));assert.deepEqual(errors,[]);
  for(const row of results){assert.equal(row.fontSize,row.expected.fontSize);assert.ok(Math.abs(row.lineHeight-row.expected.fontSize*row.expected.lineHeight)<0.1);assert.equal(row.font.includes('Georgia'),row.expected.font==='serif');assert.ok(row.body.width<=row.width+1);assert.ok(row.image.left>=row.reader.left-1,'image escapes reader left');assert.ok(row.image.right<=row.reader.left+row.reader.clientWidth+1,'image escapes reader right');assert.ok(row.reader.scrollWidth<=row.reader.clientWidth+1,'horizontal reader overflow');if(row.imageWidth==='column')assert.ok(row.image.width<=row.body.width+1);else assert.ok(row.image.width>row.body.width);}
  for(const imageWidth of ['column','wide']){const ample=results.filter(row=>row.viewport===1920&&row.imageWidth===imageWidth);assert.equal(ample.length,3);for(let i=1;i<ample.length;i++)assert.ok(Math.abs((ample[i].body.width-ample[i-1].body.width)-(ample[i].width-ample[i-1].width))<1,'article width choice must change the actual column');}
  assert.equal(typography.length,24);for(const row of typography){assert.equal(row.fontSize,row.expected.fontSize);assert.ok(Math.abs(row.lineHeight-row.expected.fontSize*row.expected.lineHeight)<0.1);assert.equal(row.font.includes('Georgia'),row.expected.font==='serif');}
}finally{await app?.evaluate(({shell})=>{if(globalThis.__readingOriginal)shell.openExternal=globalThis.__readingOriginal;}).catch(()=>{});await app?.close();await new Promise(r=>origin.close(r));rmSync(directory,{recursive:true,force:true});}
