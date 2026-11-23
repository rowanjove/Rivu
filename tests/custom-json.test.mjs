import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RivuDatabase } from '../dist-server/database.cjs';
import { createService } from '../dist-server/service.js';
import { createBackup, inspectBackup, restoreBackup } from '../dist-server/backup.js';
import { exportOpml, previewOpml, importOpml } from '../dist-server/opml.js';
import { refreshFeed } from '../dist-server/feeds.js';

const mapping={itemsPath:'data.articles',titlePath:'headline',idPath:'uuid',urlPath:'permalink',datePath:'published',contentPath:'body',summaryPath:'abstract',authorPath:'writer.name',imagePath:'photo'};
test('custom JSON API preview, subscribe, edit, refresh and backup remain local',async()=>{
  const fixture=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/broken'){res.end('{broken');return;}if(req.url==='/array'){res.end(JSON.stringify([{id:'root-one',title:'根数组文章'}]));return;}res.end(JSON.stringify({data:{articles:[{uuid:'one',headline:'测试文章',permalink:'https://example.com/one',published:'2026-09-28T00:00:00Z',body:'<p>本地正文</p>',abstract:'测试摘要',writer:{name:'作者'},photo:'https://example.com/a.png'},{uuid:'two',headline:'第二篇',body:'第二篇内容'}]}}));});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(tmpdir(),'rivu-custom-json-')),restored=mkdtempSync(join(tmpdir(),'rivu-custom-json-restore-'));
  const db=await RivuDatabase.open(join(dir,'rivu.db')),token='json-token',headers={'x-rivu-token':token};
  let service=createService(db,token,join(dir,'settings.json'),dir);
  const url=`http://127.0.0.1:${fixture.address().port}/articles`;
  try{
    const input={url,title:'自定义资讯',mapping,allowPrivate:true};
    const unauthorized=await service.app.inject({method:'POST',url:'/api/feeds/custom-json/preview',payload:input});assert.equal(unauthorized.statusCode,401);
    const blocked=await service.app.inject({method:'POST',url:'/api/feeds/custom-json/preview',headers,payload:{...input,allowPrivate:false}});assert.notEqual(blocked.statusCode,200);
    const preview=await service.app.inject({method:'POST',url:'/api/feeds/custom-json/preview',headers,payload:input});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().items.length,2);assert.equal(preview.json().items[0].author,'作者');
    const invalid=await service.app.inject({method:'POST',url:'/api/feeds/custom-json/preview',headers,payload:{...input,mapping:{...mapping,titlePath:'__proto__.secret'}}});assert.equal(invalid.statusCode,400);
    const malformed=await service.app.inject({method:'POST',url:'/api/feeds/custom-json/preview',headers,payload:{...input,url:`http://127.0.0.1:${fixture.address().port}/broken`}});assert.equal(malformed.statusCode,400,malformed.body);assert.match(malformed.json().error,/有效 JSON/);
    const root=await service.app.inject({method:'POST',url:'/api/feeds/custom-json/preview',headers,payload:{...input,url:`http://127.0.0.1:${fixture.address().port}/array`,mapping:{...mapping,itemsPath:'$',titlePath:'title',idPath:'id',urlPath:''}}});assert.equal(root.statusCode,200,root.body);assert.equal(root.json().items[0].title,'根数组文章');
    const created=await service.app.inject({method:'POST',url:'/api/feeds/custom-json',headers,payload:input});assert.equal(created.statusCode,201,created.body);const feed=created.json();assert.equal(feed.type,'custom_json');assert.equal(db.entries({feedId:feed.id}).length,2);
    const entry=db.entries({feedId:feed.id}).find(row=>row.title==='测试文章');assert.equal(entry.author,'作者');assert.equal(db.entryMedia(entry.id)[0].url,'https://example.com/a.png');
    const changed={...mapping,summaryPath:'body'};
    const edited=await service.app.inject({method:'PATCH',url:`/api/feeds/${feed.id}/json-mapping`,headers,payload:{mapping:changed}});assert.equal(edited.statusCode,200,edited.body);assert.deepEqual(JSON.parse(db.feed(feed.id).json_mapping),changed);
    const repeat=await service.app.inject({method:'POST',url:`/api/feeds/${feed.id}/refresh`,headers});assert.equal(repeat.statusCode,200,repeat.body);assert.equal(repeat.json().added,0);
    const opml=exportOpml(db),opmlDir=mkdtempSync(join(tmpdir(),'rivu-custom-json-opml-'));
    try{const target=await RivuDatabase.open(join(opmlDir,'rivu.db'));try{const planned=previewOpml(target,opml);assert.equal(planned.items[0].status,'new');assert.deepEqual(JSON.parse(planned.items[0].jsonMapping),changed);const imported=await importOpml(target,opml);assert.equal(imported.imported,1);assert.equal(target.feeds()[0].type,'custom_json');assert.deepEqual(JSON.parse(target.feeds()[0].json_mapping),changed);assert.equal(target.feeds()[0].allow_private,0);}finally{target.close();}}finally{rmSync(opmlDir,{recursive:true,force:true});}
    await service.stop();db.close();
    const zip=join(dir,'backup.zip');const snapshot=await RivuDatabase.open(join(dir,'rivu.db'));try{await createBackup(snapshot,dir,zip);}finally{snapshot.close();}
    assert.equal((await inspectBackup(zip)).schemaVersion,SCHEMA_VERSION);await restoreBackup(zip,restored);
    const recovered=await RivuDatabase.open(join(restored,'rivu.db'));try{assert.equal(recovered.feed(feed.id).type,'custom_json');assert.deepEqual(JSON.parse(recovered.feed(feed.id).json_mapping),changed);assert.equal(recovered.entries({feedId:feed.id}).length,2);assert.equal((await refreshFeed(recovered,feed.id)).added,0);}finally{recovered.close();}
  }finally{try{await service.stop();}catch{}try{db.close();}catch{}await new Promise(resolve=>fixture.close(resolve));rmSync(dir,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});

test('v20 database migration preserves subscriptions and adds JSON mapping column',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-v20-json-')),path=join(dir,'rivu.db');
  try{const old=await RivuDatabase.open(path);const feed=old.addFeed({title:'旧订阅',url:'https://example.com/rss'});old.db.exec('DROP INDEX IF EXISTS feeds_metadata; ALTER TABLE feeds DROP COLUMN json_mapping; PRAGMA user_version=20');old.close();const upgraded=await RivuDatabase.open(path);try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(upgraded.feed(feed.id).title,'旧订阅');assert.equal(upgraded.feed(feed.id).json_mapping,null);}finally{upgraded.close();}assert.equal(readdirSync(dir).filter(name=>name.startsWith('pre-migration-')).length,1);}finally{rmSync(dir,{recursive:true,force:true});}
});
