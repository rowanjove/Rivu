import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';

test('frequent searches preserve full rows, excerpts, scoped fallback and cursor order',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-search-metadata-')),db=new RivuDatabase(join(directory,'rivu.db'));
  try{
    const feed=db.addFeed({title:'Matches',url:'https://example.invalid/matches'}),other=db.addFeed({title:'Recent',url:'https://example.invalid/recent'});
    db.addEntries(feed.id,Array.from({length:1101},(_,index)=>({title:`Title ${index}`,content:'😀'.repeat(700)+' commonThree 中文',description:'Description',publishedAt:'2026-01-01',hash:`match-${index}`})));
    db.addEntries(other.id,Array.from({length:220},(_,index)=>({title:`Other ${index}`,content:'unrelated',publishedAt:'2026-01-02',hash:`other-${index}`})));
    for(const query of ['commonThree','中文','中']){
      const rich=db.entries({query,feedId:feed.id,limit:100}),page=db.entries({query,feedId:feed.id,limit:100,listOnly:true});assert.equal(rich.length,100);assert.deepEqual(page.map(row=>row.id),rich.map(row=>row.id));
      for(const row of rich){const raw=db.db.prepare('SELECT * FROM entries WHERE id=?').get(row.id);for(const [field,value] of Object.entries(raw).filter(([name])=>name!=='storage_id'))assert.equal(row[field],value,field);}
      const anchor=rich.at(-1),cursor={sortTime:anchor.published_at,id:anchor.id},next=db.entries({query,cursor,limit:100}),nextPage=db.entries({query,cursor,limit:100,listOnly:true});assert.deepEqual(nextPage.map(row=>row.id),next.map(row=>row.id));assert.equal(new Set([...rich,...next].map(row=>row.id)).size,200);
    }
    db.deleteFeed(other.id);const prepare=db.db.prepare.bind(db.db);let plan;
    db.db.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('WITH recent')){const all=statement.all;statement.all=function(...args){plan=prepare('EXPLAIN QUERY PLAN '+sql).all(...args);return all.apply(this,args);};}return statement;};
    const bounded=db.entries({query:'commonThree',listOnly:true,limit:100});assert.equal(bounded.length,100);assert.ok(plan.some(row=>/SEARCH e USING COVERING INDEX entries_list_metadata/.test(row.detail)));
    for(const row of bounded){assert.equal(row.content,'😀'.repeat(512));assert.equal(row.description,'Description');}
    for(const query of ['commonThree','中文','中']){
      const rich=db.entries({query,limit:100});assert.deepEqual(rich.map(row=>row.id),db.entries({query,limit:100,listOnly:true}).map(row=>row.id));
      for(const row of rich){const raw=prepare('SELECT * FROM entries WHERE id=?').get(row.id);for(const [field,value] of Object.entries(raw).filter(([name])=>name!=='storage_id'))assert.equal(row[field],value,field);assert.ok(!('_rivu_page_order' in row));}
      const anchor=rich.at(-1),next=db.entries({query,cursor:{sortTime:anchor.published_at,id:anchor.id},limit:100});
      assert.equal(new Set([...rich,...next].map(row=>row.id)).size,200);
      assert.deepEqual([...rich,...next].map(row=>row.id),db.entries({query,limit:200,listOnly:true}).map(row=>row.id));
      // More than the 200 recent candidates must use the complete indexed fallback.
      const large=db.entries({query,limit:500});assert.equal(large.length,500);
      assert.deepEqual(large.map(row=>row.id),db.entries({query,limit:500,listOnly:true}).map(row=>row.id));
      assert.deepEqual(db.entries({query,limit:100,offset:100}).map(row=>row.id),next.map(row=>row.id));
    }
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
