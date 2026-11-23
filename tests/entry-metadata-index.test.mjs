import {SCHEMA_VERSION} from '../dist-server/database.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RivuDatabase} from '../dist-server/database.cjs';

test('metadata indexes rebuild existing records and stay atomic with body, state and deletion',async ()=>{
  const directory=mkdtempSync(join(tmpdir(),'rivu-metadata-index-')),path=join(directory,'rivu.db');let db=await RivuDatabase.open(path);
  try{
    const feed=db.addFeed({title:'Local',url:'https://example.invalid/metadata'}),body='😀中文'.repeat(150000);
    db.db.prepare('INSERT INTO entries(id,feed_id,title,content,description,hash,fetched_at) VALUES (?,?,?,?,?,?,?)').run('large',feed.id,'Title',body,'Description','metadata','2026-01-01');
    db.db.exec('DROP INDEX entries_ai_identity; DROP INDEX entries_list_metadata; PRAGMA user_version=33');db.close();db=await RivuDatabase.open(path);
    assert.equal(db.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
    const before=db.aiBodyIdentity('large');assert.equal(before.title,'Title');
    const raw=db.db.prepare('SELECT * FROM entries WHERE id=?').get('large'),rich=db.entry('large');for(const [field,value] of Object.entries(raw).filter(([name])=>name!=='storage_id'))assert.equal(rich[field],value,field);
    const prepare=db.db.prepare,statements=[];
    db.db.prepare=function(sql){statements.push(sql);return prepare.call(this,sql);};
    try{db.entry('large');}finally{db.db.prepare=prepare;}
    assert.equal(statements.length,1);
    const [richSQL]=statements;
    const explain=prepare.bind(db.db);
    const richProgram=explain('EXPLAIN '+richSQL).all('large'),root=explain("SELECT rootpage FROM sqlite_master WHERE name='entries'").get().rootpage;
    const richTableCursors=new Set(richProgram.filter(row=>row.opcode==='OpenRead'&&row.p2===root).map(row=>row.p1)),bodyColumns=new Set(explain('PRAGMA table_info(entries)').all().filter(row=>['id','content','description','full_content'].includes(row.name)).map(row=>row.cid));
    assert.ok(!richProgram.some(row=>row.opcode==='Column'&&richTableCursors.has(row.p1)&&!bodyColumns.has(row.p2)),'rich metadata must not traverse body storage');
    assert.equal(db.entries({listOnly:true})[0].content,Array.from(body).slice(0,512).join(''));
    for(const sql of ['SELECT id,title,body_revision FROM entries INDEXED BY entries_ai_identity WHERE id=?','SELECT id,feed_id,title,author,url,published_at,fetched_at,substr(content,1,512),substr(description,1,512),cover,read,starred,saved,COALESCE(published_at,fetched_at) FROM entries INDEXED BY entries_list_metadata WHERE id=?']){
      const program=db.db.prepare('EXPLAIN '+sql).all('large'),tableRoot=db.db.prepare("SELECT rootpage FROM sqlite_master WHERE name='entries'").get().rootpage;
      const tableCursors=new Set(program.filter(row=>row.opcode==='OpenRead'&&row.p2===tableRoot).map(row=>row.p1));
      assert.ok(!program.some(row=>row.opcode==='Column'&&tableCursors.has(row.p1)),'metadata reads must come from index columns');
    }
    db.db.exec('BEGIN');db.db.prepare('UPDATE entries SET title=?,content=?,description=?,read=1,starred=1,saved=1 WHERE id=?').run('Changed','New body','New description','large');
    assert.notEqual(db.aiBodyIdentity('large').body_revision,before.body_revision);const changed=db.entries({listOnly:true})[0];assert.equal(changed.content,'New body');assert.equal(changed.description,'New description');assert.equal(changed.saved,1);
    db.db.exec('ROLLBACK');assert.deepEqual(db.aiBodyIdentity('large'),before);assert.equal(db.entries({listOnly:true})[0].saved,0);
    db.db.prepare('DELETE FROM entries WHERE id=?').run('large');assert.equal(db.aiBodyIdentity('large'),undefined);assert.deepEqual(db.entries({listOnly:true}),[]);
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
