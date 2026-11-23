import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {withSearchPostingBits} from '../dist-server/search-posting-bits.js';
const posting={sql:'SELECT rowid entry_rowid FROM entries WHERE rowid IN (1,3)',args:[]};
function fixture(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY);INSERT INTO entries(id) VALUES(1),(2),(3),(4),(5);PRAGMA temp_store=FILE');return db;}
const members=(db,name)=>db.prepare(`SELECT id FROM entries WHERE ${name}(rowid) ORDER BY id`).all().map(row=>row.id);

test('posting bitmaps keep exact membership, shared snapshot and FILE temporary storage',()=>{
 const db=fixture();try{
  assert.throws(()=>withSearchPostingBits(db,[posting],()=>[]),/快照/);db.exec('BEGIN');
  const result=withSearchPostingBits(db,[posting,{sql:'SELECT rowid entry_rowid FROM entries WHERE rowid>=? UNION ALL SELECT 3',args:[3]}],(names,counts,_packed,_byteMembership,intersectRows)=>{
   assert.deepEqual(counts,[2,4]);
   assert.deepEqual(members(db,names[0]),[1,3]);assert.deepEqual(members(db,names[1]),[3,4,5]);
   assert.deepEqual(intersectRows(),[3]);
   assert.deepEqual(withSearchPostingBits(db,[posting],()=>[]),{accepted:false,reason:'nested-search'});
   return db.prepare(`SELECT id FROM entries WHERE ${names[0]}(rowid) AND ${names[1]}(rowid)`).all();
  });
  assert.equal(result.accepted,true);assert.deepEqual(result.value.map(row=>row.id),[3]);assert.equal(result.bitmapBytes,2);
  assert.equal(db.isTransaction,true);assert.equal(db.prepare('PRAGMA temp_store').get().temp_store,1);
  assert.deepEqual(members(db,'rivu_search_bits_0'),[]);db.exec('ROLLBACK');
 }finally{db.close();}
});

test('posting bitmaps release membership on exceptions and refuse unsafe rowid or posting budgets',()=>{
 const db=fixture();try{
  db.exec('BEGIN');assert.throws(()=>withSearchPostingBits(db,[posting],()=>{throw Error('injected');}),/injected/);assert.deepEqual(members(db,'rivu_search_bits_0'),[]);
  assert.throws(()=>withSearchPostingBits(db,[posting],async()=>[]),/同步/);assert.deepEqual(members(db,'rivu_search_bits_0'),[]);
  const reused=withSearchPostingBits(db,[{sql:'SELECT 2 entry_rowid',args:[]}],names=>members(db,names[0]));assert.equal(reused.accepted,true);assert.deepEqual(reused.value,[2]);
  const tooMany={sql:'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000001) SELECT 1 entry_rowid FROM n',args:[]};
  assert.deepEqual(withSearchPostingBits(db,[tooMany],()=>assert.fail('must refuse budget')),{accepted:false,reason:'posting-budget'});
  assert.deepEqual(members(db,'rivu_search_bits_0'),[]);
  assert.deepEqual(withSearchPostingBits(db,Array(9).fill(posting),()=>assert.fail()),{accepted:false,reason:'term-budget'});
  db.exec('ROLLBACK');db.prepare('INSERT INTO entries(id) VALUES(?)').run(9007199254740993n);db.exec('BEGIN');
  assert.deepEqual(withSearchPostingBits(db,[posting],()=>assert.fail()),{accepted:false,reason:'rowid-budget'});db.exec('ROLLBACK');
 }finally{db.close();}
});

test('posting bitmaps reject malformed posting values and do not retain a previous query',()=>{
 const db=fixture();try{
  db.exec('BEGIN');assert.throws(()=>withSearchPostingBits(db,[{sql:'SELECT 1.5 entry_rowid',args:[]}],()=>assert.fail()),/行号/);
  assert.deepEqual(members(db,'rivu_search_bits_0'),[]);
  const empty=withSearchPostingBits(db,[{sql:'SELECT rowid entry_rowid FROM entries WHERE 0',args:[]}],names=>members(db,names[0]));assert.equal(empty.accepted,true);assert.deepEqual(empty.value,[]);db.exec('ROLLBACK');
 }finally{db.close();}
});
