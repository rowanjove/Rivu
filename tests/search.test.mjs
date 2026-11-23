import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../dist-server/service.js';
const require=createRequire(import.meta.url),{RivuDatabase}=require('../dist-server/database.cjs');

test('two-character search indexes article fields and local summaries',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-pairs-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'双字检索',url:'https://example.com/pairs'});
    db.addEntries(feed.id,[{title:'星河',content:'普通正文',hash:'title'},{title:'其他文章',content:'海风吹来',hash:'body'},{title:'第三篇',description:'AI工具',hash:'description'},{title:'第四篇',content:'旧文',hash:'summary'}]);
    const entries=db.entries({limit:10}),byTitle=(title)=>entries.find(row=>row.title===title);
    assert.deepEqual(db.entries({query:'星河'}).map(row=>row.id),[byTitle('星河').id]);
    assert.deepEqual(db.entries({query:'星'}).map(row=>row.id),[byTitle('星河').id]);
    assert.deepEqual(db.entries({query:'海风'}).map(row=>row.id),[byTitle('其他文章').id]);
    assert.deepEqual(db.entries({query:'海'}).map(row=>row.id),[byTitle('其他文章').id]);
    assert.deepEqual(db.entries({query:'ai'}).map(row=>row.id),[byTitle('第三篇').id]);
    assert.deepEqual(db.entries({query:'A'}).map(row=>row.id),[byTitle('第三篇').id]);
    db.saveAI(byTitle('第四篇').id,'summary','','local','fixture','冬雨将至');
    assert.deepEqual(db.entries({query:'冬雨'}).map(row=>row.id),[byTitle('第四篇').id]);
    assert.deepEqual(db.entries({query:'冬'}).map(row=>row.id),[byTitle('第四篇').id]);
    db.saveAI(byTitle('第四篇').id,'summary','','local','fixture','春风将至');
    assert.deepEqual(db.entries({query:'冬雨'}),[]);
    assert.deepEqual(db.entries({query:'春风'}).map(row=>row.id),[byTitle('第四篇').id]);
    db.setFullContent(byTitle('第四篇').id,'<p>🚀星际航行</p>');
    assert.deepEqual(db.entries({query:'🚀星'}).map(row=>row.id),[byTitle('第四篇').id]);
    assert.deepEqual(db.entries({query:'🚀'}).map(row=>row.id),[byTitle('第四篇').id]);
    assert.deepEqual(db.entries({query:'春风'}),[]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('v18 pair indexes rebuild with single-character tokens',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-unigram-migrate-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧单字',url:'https://example.com/old-unigram'});
    old.addEntries(feed.id,[{title:'云海',hash:'old'}]);const id=old.entries()[0].id;
    old.saveAI(id,'summary','','local','fixture','秋雨');
    old.db.exec('DELETE FROM entry_pair_fts; DELETE FROM ai_result_pair_fts; PRAGMA user_version=18');old.close();
    const upgraded=await RivuDatabase.open(path);
    try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(upgraded.entries({query:'云'}).map(row=>row.id),[id]);assert.deepEqual(upgraded.entries({query:'秋'}).map(row=>row.id),[id]);}
    finally{upgraded.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v17 articles and summaries migrate into the two-character index',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-pair-migrate-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧双字',url:'https://example.com/old-pairs'});
    old.addEntries(feed.id,[{title:'云海',hash:'old'}]);const id=old.entries()[0].id;
    old.saveAI(id,'summary','','local','fixture','秋雨');
    old.db.exec('DROP TRIGGER entry_pair_ai; DROP TRIGGER entry_pair_ad; DROP TRIGGER entry_pair_au; DROP TRIGGER ai_result_pair_ai; DROP TRIGGER ai_result_pair_ad; DROP TRIGGER ai_result_pair_au; DROP TABLE entry_pair_fts; DROP TABLE ai_result_pair_fts; PRAGMA user_version=17');old.close();
    const upgraded=await RivuDatabase.open(path);
    try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(upgraded.entries({query:'云海'}).map(row=>row.id),[id]);assert.deepEqual(upgraded.entries({query:'秋雨'}).map(row=>row.id),[id]);}
    finally{upgraded.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('search combines FTS and AI summary hits without changing multi-term matching',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'检索测试',url:'https://example.com/feed'});
    db.addEntries(feed.id,[{title:'独有标题词',content:'普通正文',hash:'title'},{title:'第二篇文章',content:'另一段普通正文',hash:'summary'}]);
    const second=db.entries().find(row=>row.title==='第二篇文章');
    db.db.prepare('INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('summary-test',second.id,'summary','','local','fixture','独有摘要词 额外信息','v1','hash',new Date().toISOString());
    assert.deepEqual(db.entries({query:'独有标题词'}).map(row=>row.title),['独有标题词']);
    assert.deepEqual(db.entries({query:'独有摘要词'}).map(row=>row.title),['第二篇文章']);
    assert.deepEqual(db.entries({query:'独有摘要词 AND 第二篇文章'}).map(row=>row.title),['第二篇文章']);
    assert.deepEqual(db.entries({query:'独有标题词 AND 独有摘要词'}),[]);
    db.saveAI(second.id,'summary','','local','fixture','已更新的摘要词');
    assert.deepEqual(db.entries({query:'独有摘要词'}),[]);
    assert.deepEqual(db.entries({query:'已更新的摘要词'}).map(row=>row.id),[second.id]);
    db.db.prepare('DELETE FROM ai_results WHERE entry_id=?').run(second.id);
    assert.deepEqual(db.entries({query:'已更新的摘要词'}),[]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('v15 AI summaries migrate into FTS without losing existing results',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-ai-fts-migrate-')),path=join(dir,'rivu.db');
  try{
    const old=await RivuDatabase.open(path),feed=old.addFeed({title:'旧索引',url:'https://example.com/old-fts'});
    old.addEntries(feed.id,[{title:'旧文章',content:'原文',hash:'old'}]);
    const id=old.entries()[0].id;
    old.saveAI(id,'summary','','local','fixture','迁移保留的摘要词');
    old.db.exec('DROP TRIGGER ai_result_ai; DROP TRIGGER ai_result_ad; DROP TRIGGER ai_result_au; DROP TABLE ai_result_fts; PRAGMA user_version=15');
    old.close();
    const upgraded=await RivuDatabase.open(path);
    try{assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.deepEqual(upgraded.entries({query:'迁移保留的摘要词'}).map(row=>row.id),[id]);}
    finally{upgraded.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('frequent AI summary terms use ordered search and keep exact matches',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-frequent-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'大量摘要',url:'https://example.com/frequent'});
    db.addEntries(feed.id,Array.from({length:1101},(_,index)=>({title:`文章 ${index}`,content:'正文',publishedAt:new Date(Date.UTC(2026,0,1)+index*1000).toISOString(),hash:`frequent-${index}`})));
    const rows=db.entries({limit:500}),all=[...rows,...db.entries({limit:500,cursor:{sortTime:rows.at(-1).published_at,id:rows.at(-1).id}})];
    const last=all.at(-1);all.push(...db.entries({limit:500,cursor:{sortTime:last.published_at,id:last.id}}));
    const insert=db.db.prepare('INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.db.exec('BEGIN');try{for(let index=0;index<all.length;index++)insert.run(`frequent-${index}`,all[index].id,'summary','','local','fixture',`共同摘要词 ${index}`,'v1','','2026-09-26');db.db.exec('COMMIT');}catch(error){db.db.exec('ROLLBACK');throw error;}
    assert.deepEqual(db.entries({query:'共同摘要词',limit:100}).map(row=>row.id),all.slice(0,100).map(row=>row.id));
    assert.deepEqual(db.entries({query:'摘要',limit:100}).map(row=>row.id),all.slice(0,100).map(row=>row.id));
    assert.deepEqual(db.entries({query:'共同摘要词 AND 文章 1100',limit:100}).map(row=>row.id),[all[0].id,all.at(-1).id]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('frequent search ignores feed content replaced by full content in recent entries',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-replaced-body-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'全文替换',url:'https://example.com/replaced-body'});
    const publishedAt=index=>new Date(Date.UTC(2026,0,1)+index*1000).toISOString();
    db.addEntries(feed.id,Array.from({length:1101},(_,index)=>({title:`目标长词 ${index}`,content:'普通正文',publishedAt:publishedAt(index),hash:`match-${index}`})));
    db.addEntries(feed.id,Array.from({length:150},(_,index)=>({title:`近期无关 ${index}`,content:'目标长词仅在旧订阅正文',publishedAt:publishedAt(1101+index),hash:`stale-${index}`})));
    db.db.prepare("UPDATE entries SET full_content='替换后的全文没有该词' WHERE title LIKE '近期无关 %'").run();
    const expected=db.entries({limit:100,offset:150}).map(row=>row.id);
    assert.equal(expected.length,100);
    assert.deepEqual(db.entries({query:'目标长词',limit:100}).map(row=>row.id),expected);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('frequent matches confined to old entries fall back without losing results',async ()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-search-old-frequent-')),db=await RivuDatabase.open(join(dir,'rivu.db'));
  try{
    const feed=db.addFeed({title:'历史摘要',url:'https://example.com/old-frequent'});
    db.addEntries(feed.id,Array.from({length:3500},(_,index)=>({title:`历史文章 ${index}`,publishedAt:new Date(Date.UTC(2026,0,1)+index*1000).toISOString(),hash:`old-frequent-${index}`})));
    const oldest=db.entries({limit:500,offset:2399});
    const ids=[...oldest,...db.entries({limit:500,offset:2899}),...db.entries({limit:101,offset:3399})];
    assert.equal(ids.length,1101);
    const insert=db.db.prepare('INSERT INTO ai_results(id,entry_id,type,language,provider,model,content,prompt_version,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.db.exec('BEGIN');try{for(let index=0;index<ids.length;index++)insert.run(`old-summary-${index}`,ids[index].id,'summary','','local','fixture','历史共同摘要词','v1','','2026-09-26');db.db.exec('COMMIT');}catch(error){db.db.exec('ROLLBACK');throw error;}
    assert.deepEqual(db.entries({query:'历史共同摘要词',limit:100}).map(row=>row.id),ids.slice(0,100).map(row=>row.id));
    assert.deepEqual(db.entries({query:'共同',limit:100}).map(row=>row.id),ids.slice(0,100).map(row=>row.id));
    assert.deepEqual(db.entries({query:'摘',limit:100}).map(row=>row.id),ids.slice(0,100).map(row=>row.id));
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('cursor pagination has stable order across equal timestamps and new inserts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-cursor-')),db=await RivuDatabase.open(join(dir,'rivu.db')),service=createService(db,'cursor-token',join(dir,'settings.json'),dir);
  const headers={'x-rivu-token':'cursor-token'},publishedAt='2026-09-26T00:00:00.000Z';
  try{
    const feed=db.addFeed({title:'游标订阅',url:'https://example.com/cursor'});
    db.addEntries(feed.id,Array.from({length:5},(_,index)=>({title:`同时间文章 ${index}`,content:'正文',publishedAt,hash:`equal-${index}`})));
    const first=db.entries({limit:2}),last=first.at(-1),cursor={sortTime:last.published_at||last.fetched_at,id:last.id};
    db.addEntries(feed.id,[{title:'新文章',content:'正文',publishedAt:'2026-09-27T00:00:00.000Z',hash:'new'}]);
    const second=db.entries({limit:2,cursor}),third=db.entries({limit:2,cursor:{sortTime:second.at(-1).published_at||second.at(-1).fetched_at,id:second.at(-1).id}});
    assert.equal(new Set([...first,...second,...third].map(row=>row.id)).size,5);
    assert.ok([...second,...third].every(row=>row.title!=='新文章'));
    assert.deepEqual([...first,...second,...third].map(row=>row.id),db.entries({limit:10}).filter(row=>row.title!=='新文章').map(row=>row.id));
    const url=`/api/entries?limit=2&beforeTime=${encodeURIComponent(cursor.sortTime)}&beforeId=${cursor.id}`;
    assert.deepEqual((await service.app.inject({method:'GET',url,headers})).json().map(row=>row.id),second.map(row=>row.id));
    const created=await service.app.inject({method:'POST',url:'/api/smart-folders',headers,payload:{name:'同时间分类',query:'同时间文章'}});assert.equal(created.statusCode,201);
    const folderId=created.json().id,folderUrl=`/api/smart-folders/${folderId}/entries?limit=2&beforeTime=${encodeURIComponent(cursor.sortTime)}&beforeId=${cursor.id}`;
    assert.deepEqual((await service.app.inject({method:'GET',url:folderUrl,headers})).json().map(row=>row.id),second.map(row=>row.id));
    assert.equal((await service.app.inject({method:'GET',url:'/api/entries?beforeTime=bad&beforeId=bad',headers})).statusCode,400);
    for(const invalid of ['/api/entries?limit=-1','/api/entries?limit=501','/api/entries?limit=NaN','/api/entries?offset=-1','/api/entries?offset=NaN'])assert.equal((await service.app.inject({method:'GET',url:invalid,headers})).statusCode,400);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('smart folder marks over two cursor pages read without skips',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-folder-cursor-')),db=await RivuDatabase.open(join(dir,'rivu.db')),service=createService(db,'folder-token',join(dir,'settings.json'),dir);
  const headers={'x-rivu-token':'folder-token'};
  try{
    const feed=db.addFeed({title:'批量订阅',url:'https://example.com/folder-cursor'});
    db.addEntries(feed.id,Array.from({length:1101},(_,index)=>({title:`目标文章 ${index}`,content:'正文',publishedAt:'2026-09-26T00:00:00.000Z',hash:`folder-${index}`})));
    const created=await service.app.inject({method:'POST',url:'/api/smart-folders',headers,payload:{name:'全部未读',query:'目标文章 is:unread'}});
    assert.equal(created.statusCode,201,created.body);
    const marked=await service.app.inject({method:'POST',url:'/api/entries/mark-read',headers,payload:{smartFolderId:created.json().id}});
    assert.equal(marked.statusCode,200,marked.body);
    assert.equal(marked.json().changed,1101);
    assert.equal(db.db.prepare('SELECT count(*) n FROM entries WHERE read=0').get().n,0);
  }finally{await service.stop();db.close();rmSync(dir,{recursive:true,force:true});}
});
