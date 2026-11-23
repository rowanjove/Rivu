import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
const output=process.env.RIVU_FEED_PAGES_RESULT;assert.ok(output&&!existsSync(output));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-feed-pages-')),model=new RivuDatabase(join(directory,'rivu.db'));
try{for(let i=0;i<1000;i++)model.addFeed({title:'Page source '+String(i).padStart(4,'0'),url:'https://example.invalid/'+i,fetchInterval:0});}finally{model.close();}
let app;
try{
 app=await electron.launch({executablePath:resolve(process.env.RIVU_TEST_EXE),args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.waitForFunction(()=>document.querySelectorAll('.feed-nav').length===1000);await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('checkbox',{name:'选择全部订阅',exact:true}).check();await page.waitForFunction(()=>document.querySelector('.feed-bulk-toolbar label')?.textContent.includes('1000'));
 const sources=new Set();for(let n=0;n<20;n++){
  const labels=await page.locator('.feed-setting input[type="checkbox"][aria-label]').evaluateAll(elements=>elements.map(e=>({label:e.getAttribute('aria-label'),checked:e.checked})));
  assert.equal(labels.length,50);assert.ok(labels.every(row=>row.checked));for(const row of labels){assert.ok(!sources.has(row.label));sources.add(row.label);}
  const next=page.getByRole('button',{name:'下一页订阅',exact:true});if(n<19)await next.click();else assert.equal(await next.isDisabled(),true);
 }
 assert.equal(sources.size,1000);await app.close();app=undefined;writeFileSync(output,JSON.stringify({status:'PASS',directory,executable:resolve(process.env.RIVU_TEST_EXE),sourcesVisited:1000,pages:20,rowsPerPage:50,allPagesSelected:true,scope:'Actual packaged settings pagination and global select-all, not500k-entry performance acceptance'},null,2),{flag:'wx'});console.log('PASS1000-source settings pages and global selection');
}finally{await app?.close();}
