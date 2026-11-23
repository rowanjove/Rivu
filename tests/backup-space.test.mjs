import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yazl from 'yazl';
import { restoreBackup } from '../dist-server/backup.js';

test('backup space budget rejects mocked exhaustion before extraction', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rivu-backup-space-test-'));
  try{
    const output=join(directory,'backup-space.cjs');
    await build({entryPoints:[resolve('shared/backup-space.ts')],bundle:true,platform:'node',format:'cjs',outfile:output});
    const space=await import(pathToFileURL(output));
    const plan=space.backupSpacePlan({sourceBytes:100,totalUncompressedBytes:200,currentDbBytes:300,currentSettingsBytes:40,migrationBytes:50});
    assert.doesNotThrow(()=>space.assertAvailableSpace(plan,{temp:plan.tempBytes,target:plan.targetBytes}));
    assert.throws(()=>space.assertAvailableSpace(plan,{temp:plan.tempBytes-1,target:plan.targetBytes}),/可用空间不足/);
    assert.throws(()=>space.assertAvailableSpace(plan,{temp:plan.tempBytes,target:plan.targetBytes-1}),/可用空间不足/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('backup entry metadata rejects duplicates, unknown files and oversized expansion', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rivu-backup-entry-test-'));
  try{
    const output=join(directory,'backup-space.cjs');
    await build({entryPoints:[resolve('shared/backup-space.ts')],bundle:true,platform:'node',format:'cjs',outfile:output});
    const space=await import(pathToFileURL(output));
    const valid=space.validateBackupEntries([
      {fileName:'manifest.json',uncompressedSize:32},
      {fileName:'rivu.db',uncompressedSize:1024},
      {fileName:'settings.json',uncompressedSize:64},
    ]);
    assert.equal(valid.totalUncompressedBytes,1120);
    for(const fileName of ['__proto__','constructor','toString'])assert.throws(()=>space.validateBackupEntries([
      {fileName:'manifest.json',uncompressedSize:32},{fileName:'rivu.db',uncompressedSize:1024},{fileName,uncompressedSize:1},
    ]),/无效/);
    assert.throws(()=>space.validateBackupEntries([
      {fileName:'manifest.json',uncompressedSize:32},
      {fileName:'rivu.db',uncompressedSize:1024},
      {fileName:'rivu.db',uncompressedSize:1024},
    ]),/重复/);
    assert.throws(()=>space.validateBackupEntries([
      {fileName:'manifest.json',uncompressedSize:32},
      {fileName:'rivu.db',uncompressedSize:1024},
      {fileName:'unexpected.bin',uncompressedSize:1},
    ]),/无效/);
    assert.throws(()=>space.validateBackupEntries([
      {fileName:'manifest.json',uncompressedSize:32},
      {fileName:'rivu.db',uncompressedSize:20*1024*1024*1024+1},
    ]),/超出大小限制/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('invalid ZIP metadata is rejected before target extraction and keeps existing files', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'rivu-backup-zip-preflight-'));
  try{
    const archive=join(directory,'invalid.zip'),target=join(directory,'target');
    await mkdir(target);await writeFile(join(target,'keep.txt'),'keep');
    const zip=new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify({format:'rivu-backup',version:2,schemaVersion:44})),'manifest.json');
    zip.addBuffer(Buffer.from('not-a-database'),'rivu.db');
    zip.addBuffer(Buffer.from('unexpected'),'unexpected.bin');
    zip.end();
    await new Promise((resolve,reject)=>zip.outputStream.pipe(createWriteStream(archive)).on('close',resolve).on('error',reject));
    await assert.rejects(restoreBackup(archive,target),/条目|无效/);
    assert.deepEqual((await readdir(target)).sort(),['keep.txt']);
  }finally{await rm(directory,{recursive:true,force:true});}
});
