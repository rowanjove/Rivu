import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';
test('ID-first list pages preserve rich-query membership, order, state and SQLite Unicode snippets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rivu-list-page-')),db=new RivuDatabase(join(dir,'rivu.db'));
  try{const feed=db.addFeed({title:'First',url:'https://example.invalid/first'}),second=db.addFeed({title:'Second',url:'https://example.invalid/second'});for(const source of [feed,second])db.addEntries(source.id,Array.from({length:105},(_,index)=>({title:`Article ${index}`,content:'<p>common 中文😀 '+('body '.repeat(1500))+'</p>',publishedAt:'2026-01-01T00:00:00.000Z',hash:String(index)})));const all=db.entries({view:'all',limit:500});all.forEach((entry,index)=>db.updateEntry(entry.id,{read:index%2===0,starred:index%3===0,saved:index%5===0}));
    for(const scope of [{view:'all'},{view:'unread'},{view:'starred'},{view:'saved'},{feedId:feed.id},{query:'common'},{query:'中'},{query:'feed:First common'},{view:'all',cursor:{sortTime:all[49].published_at,id:all[49].id}}])for(const offset of (scope.cursor?[0]:[0,40,80])){const options={...scope,offset,limit:40},rich=db.entries(options),page=db.entries({...options,listOnly:true});assert.deepEqual(page.map(row=>row.id),rich.map(row=>row.id));for(let index=0;index<page.length;index++){assert.equal(page[index].title,rich[index].title);assert.equal(page[index].read,rich[index].read);assert.equal(page[index].starred,rich[index].starred);assert.equal(page[index].saved,rich[index].saved);assert.equal(page[index].feed_title,rich[index].feed_title);assert.equal(page[index].content,db.db.prepare('SELECT substr(content,1,512) content FROM entries WHERE id=?').get(page[index].id).content);assert.ok(Buffer.byteLength(page[index].content)<1000);}}
    const prepare=db.db.prepare.bind(db.db);let plan;
    db.db.prepare=sql=>{if(sql.startsWith('WITH selected'))plan=prepare('EXPLAIN QUERY PLAN '+sql).all(40,0);return prepare(sql);};
    db.entries({listOnly:true,limit:40});
    assert.ok(plan.some(row=>/SEARCH e USING COVERING INDEX entries_list_metadata \(id=\?\)/.test(row.detail)),'selected page must seek covered metadata by ID');
    assert.ok(!plan.some(row=>row.parent===0&&/^SCAN e\b/.test(row.detail)),'outer page must not scan the whole entries table');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
