import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['shared/reading-anchor.ts'],bundle:true,format:'esm',platform:'node',write:false,metafile:true});
const {parseArticleAnchor}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
test('wire validator has no DOM, application, database or filesystem import dependency',()=>{
 assert.deepEqual(Object.keys(result.metafile.inputs),['shared/reading-anchor.ts']);
 assert.equal(typeof globalThis.document,'undefined');
 const wire={version:1,revision:'b'.repeat(64),path:[1,2],tag:'P',head:'hello',tail:'world',offset:-7};
 assert.deepEqual(parseArticleAnchor(JSON.parse(JSON.stringify(wire))),wire);
 const parsed=parseArticleAnchor(wire);parsed.path.push(9);assert.deepEqual(wire.path,[1,2]);
});
test('legacy missing anchor is distinct from invalid supplied anchor',()=>{
 assert.equal(parseArticleAnchor(undefined),null);assert.equal(parseArticleAnchor(null),null);
 for(const value of ['',{},[],{version:1},JSON.stringify({version:1})])assert.equal(parseArticleAnchor(value),null);
});
