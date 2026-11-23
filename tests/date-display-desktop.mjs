import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {_electron as electron} from 'playwright-core';
import {RivuDatabase} from '../dist-server/database.cjs';
assert.ok(process.env.RIVU_TEST_EXE);
const directory=mkdtempSync(join(tmpdir(),'rivu-date-display-')),path=join(directory,'rivu.db'),scope=relative(resolve(tmpdir()),resolve(directory));assert.ok(scope.startsWith('rivu-date-display-')&&!scope.startsWith('..')&&!isAbsolute(scope));
const db=new RivuDatabase(path),feed=db.addFeed({title:'Date fixture',url:'https://example.invalid/dates',fetchInterval:0});
db.addEntries(feed.id,[{title:'Invalid publication',publishedAt:'zz-invalid-date',content:'<p>Local body</p>',hash:'invalid-pub'},{title:'Invalid fallback',content:'<p>Local body</p>',hash:'invalid-fetch'},{title:'Valid publication',publishedAt:'2026-09-28T00:00:00Z',content:'<p>Local body</p>',hash:'valid'}]);
db.db.prepare("UPDATE entries SET fetched_at='zz-invalid-fetch' WHERE hash='invalid-fetch'").run();
db.db.prepare("UPDATE feeds SET last_fetched_at='invalid-fetch',last_success_at='invalid-success',next_fetch_at='invalid-next' WHERE id=?").run(feed.id);db.close();
let application;const errors=[];
try{
  application=await electron.launch({executablePath:process.env.RIVU_TEST_EXE,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
  let page;const end=Date.now()+30000;while(Date.now()<end){page=application.windows().find(w=>w.url().includes('/index.html'));if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);page.on('pageerror',e=>errors.push(String(e)));
  try{await page.getByText('Invalid publication',{exact:true}).waitFor({timeout:10000});}catch(error){console.log(JSON.stringify({errors}));throw error;}
  for(const title of ['Invalid publication','Invalid fallback'])assert.equal(await page.locator('.entry-row').filter({hasText:title}).locator('time').textContent(),'未知时间');
  await page.getByText('Invalid publication',{exact:true}).click();await page.locator('.reader-content h1').getByText('Invalid publication',{exact:true}).waitFor();assert.ok((await page.locator('.reader-content').textContent()).includes('未知时间'));
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name:'订阅',exact:true}).click();
  const setting=page.locator('.feed-setting').filter({hasText:'Date fixture'});assert.equal((await setting.textContent()).match(/未知时间/g)?.length,3);assert.equal(errors.length,0,JSON.stringify(errors));
  await application.close();application=null;const check=new RivuDatabase(path);
  try{assert.equal(check.db.prepare("SELECT published_at FROM entries WHERE hash='invalid-pub'").get().published_at,'zz-invalid-date');assert.equal(check.db.prepare("SELECT fetched_at FROM entries WHERE hash='invalid-fetch'").get().fetched_at,'zz-invalid-fetch');assert.equal(check.feed(feed.id).next_fetch_at,'invalid-next');}finally{check.close();}
  console.log('Invalid dates remain stored and display safely in timeline, reader and subscription settings');
}finally{await application?.close();rmSync(directory,{recursive:true,force:true});}
