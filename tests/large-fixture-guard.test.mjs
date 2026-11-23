import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';

test('native fixture creator refuses default execution before reading source manifest or creating a bench directory',()=>{
 const before=readdirSync(resolve('bench-data')).sort(),env={...process.env};
 delete env.RIVU_NATIVE_CREATE_FIXTURE;
 // If the guard regresses, missing configuration prevents a real large copy.
 env.RIVU_IMAGE_SOURCE_MANIFEST=resolve('bench-data','must-not-open-source-manifest.json');
 env.RIVU_TEST_EXE='';env.RIVU_IMAGE_RESULT='';
 const result=spawnSync(process.execPath,['scripts/native-image-writer-desktop-smoke.mjs'],{cwd:resolve('.'),env,encoding:'utf8',timeout:15000,windowsHide:true});
 assert.ifError(result.error);assert.notEqual(result.status,0);
 assert.match(result.stderr,/RIVU_NATIVE_CREATE_FIXTURE=1/);assert.doesNotMatch(result.stderr,/ENOENT/);
 assert.deepEqual(readdirSync(resolve('bench-data')).sort(),before);
});
