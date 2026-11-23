import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {_electron as electron} from 'playwright-core';
const output=process.env.RIVU_DISCOVERY_ERROR_RESULT;assert.ok(output&&!existsSync(output));
const candidate=JSON.parse(readFileSync('artifacts/rivu-directory-latest.json','utf8'));
const directory=mkdtempSync(join(resolve('bench-data'),'rivu-discovery-error-'));let app,hits=0;
const fixture=createServer((_req,res)=>{hits++;res.setHeader('content-type','application/rss+xml');res.end('<rss version="2.0"><channel><title>Explicit local source</title><item><title>Local preview</title><guid>one</guid></item></channel></rss>');});await new Promise(done=>fixture.listen(0,'127.0.0.1',done));
const report={status:'RUNNING',candidate,directory,scope:'Real packaged add-source dialog, actionable failure with no unauthorized loopback request, explicit per-source private permission and successful preview; no public source compatibility claim.'};
try{
 app=await electron.launch({executablePath:candidate.executablePath,args:['--no-sandbox'],env:{...process.env,RIVU_DATA_DIR:directory}});
 let page;const deadline=Date.now()+30000;while(Date.now()<deadline){page=app.windows().find(p=>p.url().includes('/index.html'));if(page)break;await new Promise(done=>setTimeout(done,100));}assert.ok(page);
 await page.getByRole('button',{name:'添加订阅',exact:true}).first().click();const dialog=page.locator('.dialog');
 await dialog.getByPlaceholder('https://example.com',{exact:true}).fill(`http://127.0.0.1:${fixture.address().port}/feed.rss`);await dialog.getByRole('button',{name:'检测',exact:true}).click();
 await dialog.locator('.dialog-error').filter({hasText:'初始地址检查失败：禁止访问本机或内网地址'}).waitFor();
 report.deniedRequests=hits;assert.equal(hits,0);const permission=dialog.getByRole('checkbox');assert.equal(await permission.isChecked(),false);
 await permission.check();await dialog.getByRole('button',{name:'检测',exact:true}).click();await dialog.locator('.feed-preview h3').filter({hasText:'Explicit local source'}).waitFor();
 assert.ok(hits>0);assert.equal(await permission.isChecked(),true);assert.equal(await dialog.locator('.dialog-error').count(),0);
 assert.equal((await page.evaluate(()=>window.rivu.request('GET','/api/feeds'))).length,0,'Preview does not create a subscription');
 report.explicitPermissionPreviewRequests=hits;report.noSubscriptionCreated=true;report.status='PASS-scoped-discovery-error-ui';
}catch(error){report.status='FAIL';report.error=String(error);throw error;}
finally{if(app)await app.close();fixture.closeAllConnections();await new Promise(done=>fixture.close(done));writeFileSync(output,JSON.stringify(report,null,2));}
console.log(report.status);
