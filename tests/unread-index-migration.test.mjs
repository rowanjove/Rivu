import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RivuDatabase} from '../dist-server/database.cjs';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'rivu-unread-migrate-')),path=join(directory,'rivu.db'),db=new RivuDatabase(path);
  const feed=db.addFeed({title:'Local',url:'https://example.invalid/unread'});
  db.addEntries(feed.id,[{title:'Unread',content:'😀本地正文',publishedAt:'2026-01-01',hash:'one'},{title:'Read',content:'已读正文',hash:'two'}]);
  const rows=db.entries();db.updateEntry(rows[0].id,{read:true,saved:true,starred:true});
  const before=db.db.prepare('SELECT * FROM entries ORDER BY id').all();
  db.db.exec('DROP INDEX entries_unread_cursor; PRAGMA user_version=34');db.close();
  return {directory,path,before};
}

test('schema34 upgrade preserves every article field and snapshot, and unread index tracks transactional state',async ()=>{
  const f=fixture();
  try{
    const db=await RivuDatabase.open(f.path);
    try{
      assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
      assert.deepEqual(db.db.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);
      const ids=()=>db.db.prepare('SELECT id FROM entries INDEXED BY entries_unread_cursor WHERE read=0 ORDER BY COALESCE(published_at,fetched_at) DESC,id DESC').all().map(row=>row.id);
      const original=ids();assert.equal(original.length,1);
      db.db.exec('BEGIN');db.updateEntry(original[0],{read:true});assert.equal(ids().length,0);db.db.exec('ROLLBACK');assert.deepEqual(ids(),original);
      db.updateEntry(original[0],{read:true});assert.equal(ids().length,0);db.updateEntry(original[0],{read:false});assert.deepEqual(ids(),original);
      db.deleteFeed(db.feeds()[0].id);assert.equal(ids().length,0);
    }finally{db.close();}
    const snapshot=readdirSync(f.directory).find(name=>name.startsWith('pre-migration-'));
    assert.ok(snapshot);const old=new DatabaseSync(join(f.directory,snapshot),{readOnly:true});
    try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,34);assert.deepEqual(old.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name='entries_unread_cursor'").get(),undefined);}finally{old.close();}
  }finally{rmSync(f.directory,{recursive:true,force:true});}
});

test('failed unread index migration rolls back version, index and article changes',async ()=>{
  const f=fixture(),exec=DatabaseSync.prototype.exec;
  try{
    DatabaseSync.prototype.exec=function(sql){if(sql.includes('CREATE INDEX IF NOT EXISTS entries_unread_cursor'))throw Error('injected unread index failure');return exec.call(this,sql);};
    await assert.rejects(()=>RivuDatabase.open(f.path),/injected unread index failure/);
    DatabaseSync.prototype.exec=exec;
    const old=new DatabaseSync(f.path,{readOnly:true});
    try{assert.equal(old.prepare('PRAGMA user_version').get().user_version,34);assert.deepEqual(old.prepare('SELECT * FROM entries ORDER BY id').all(),f.before);assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name='entries_unread_cursor'").get(),undefined);}finally{old.close();}
    assert.ok(readdirSync(f.directory).some(name=>name.startsWith('pre-migration-')));
  }finally{DatabaseSync.prototype.exec=exec;rmSync(f.directory,{recursive:true,force:true});}
});
