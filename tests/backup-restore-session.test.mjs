import test from 'node:test';
import assert from 'node:assert/strict';
import {BackupRestoreSession} from '../dist-server/backup-restore-session.js';

test('restore admission rejects overlap and shutdown protection spans the full commit callback',async()=>{
 const session=new BackupRestoreSession();let begin,finish;
 const held=new Promise(done=>{finish=done;});
 const running=session.run(async start=>{begin=start;await held;return 'restored';});
 assert.equal(session.committing,false);
 await assert.rejects(session.run(async()=>{}),error=>error.statusCode===409);
 begin();assert.equal(session.committing,true);
 await assert.rejects(session.run(async()=>{}),error=>error.statusCode===409);
 finish();assert.equal(await running,'restored');assert.equal(session.committing,false);
 assert.throws(begin,/已结束/);
 assert.equal(await session.run(async()=>null),null);
});

test('failed commit releases shutdown protection only after recovery callback finishes',async()=>{
 const session=new BackupRestoreSession();let release;
 const recovering=new Promise(done=>{release=done;});
 const running=session.run(async begin=>{begin();await recovering;throw Error('restoration failed after recovery');});
 assert.equal(session.committing,true);release();await assert.rejects(running,/after recovery/);
 assert.equal(session.committing,false);assert.equal(await session.run(async()=>42),42);
});
