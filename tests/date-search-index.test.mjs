import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';

test('today and date searches preserve lexical prefix semantics at digit, month and year edges',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-date-index-')),db=new RivuDatabase(join(directory,'rivu.db'));
  try{
    const feed=db.addFeed({title:'Dates',url:'https://example.invalid/dates'});
    let day='2026-01-09';db.db.function('date',{varargs:true},()=>day);
    const published=[null,'',...'2026-01-09 2026-02-28 2026-12-31'.split(' ').flatMap(value=>[value,value+'T00:00:00Z',value+'T23:59:59+08:00',value+'😀',value+'\u{10ffff}tail',value+'\0tail',value+'0suffix']), '2026-01-1:','2026-02-29','2027-01-01'];
    assert.equal(db.addEntries(feed.id,published.map((publishedAt,index)=>({title:`Date ${index}`,publishedAt,content:`Exact body ${index}`,hash:`date-${index}`}))),published.length);
    const prepare=db.db.prepare.bind(db.db);let plans=[];
    db.db.prepare=sql=>{const statement=prepare(sql),all=statement.all;statement.all=function(...args){plans.push(prepare('EXPLAIN QUERY PLAN '+sql).all(...args));return all.apply(this,args);};return statement;};
    for(day of ['2026-01-09','2026-02-28','2026-12-31']){
      prepare('UPDATE entries SET fetched_at=? WHERE published_at IS NULL').run(day+'T12:00:00Z');
      const expected=prepare("SELECT id FROM entries WHERE substr(published_at,1,10)=date('now','localtime') ORDER BY COALESCE(published_at,fetched_at) DESC,id DESC").all().map(row=>row.id);
      for(const listOnly of [true,false])assert.deepEqual(db.entries({view:'today',listOnly}).map(row=>row.id),expected);
    }
    assert.ok(plans.some(plan=>plan.some(row=>/SEARCH e USING INDEX entries_time.*published_at>.*published_at</.test(row.detail))));
    for(const value of ['2026-01-09','2026-02-28','2026-12-31','2026','2026-12-31XYZ'])for(const kind of ['after','before']){
      const comparison=kind==='after'?'>=':'<',expected=prepare(`SELECT id FROM entries WHERE substr(COALESCE(published_at,fetched_at),1,10)${comparison}? ORDER BY COALESCE(published_at,fetched_at) DESC,id DESC`).all(value).map(row=>row.id);
      for(const listOnly of [true,false])assert.deepEqual(db.entries({query:`${kind}:${value}`,listOnly}).map(row=>row.id),expected);
    }
    for(const direction of ['>','<'])assert.ok(plans.some(plan=>plan.some(row=>row.detail.includes('SEARCH v USING COVERING INDEX rivu_visibility_timeline')&&row.detail.includes('sort_bucket'+direction))),`date ${direction} must seek a physical bucket range`);
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
