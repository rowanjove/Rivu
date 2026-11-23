import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BUILD_INFO_RELATIVE_PATH,
  collectHashInputs,
  createBuildInfo,
} from '../scripts/create-build-info.mjs';

function fixtureProject() {
  const root = join(tmpdir(), `rivu-build-info-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  for (const directory of ['src', 'server', 'electron', 'shared', 'scripts']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 'test' }));
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'vite.config.ts'), 'export default {};');
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'scripts', 'create-build-info.mjs'), '// generator');
  writeFileSync(join(root, 'server', 'database.ts'), 'export const SCHEMA_VERSION = 44;');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 1;');
  writeFileSync(join(root, 'shared', BUILD_INFO_RELATIVE_PATH.split('/').at(-1)), '{"buildId":"user-data"}');
  writeFileSync(join(root, 'rivu.db'), 'must not be read');
  return root;
}

test('build id is stable, excludes generated info, and changes with source', () => {
  const root = fixtureProject();
  try {
    const fixedDate = new Date('2026-01-02T03:04:05.000Z');
    const inputs = collectHashInputs(root).map((path) => path.replaceAll('\\', '/'));
    assert.equal(inputs.some((path) => path.endsWith('/shared/build-info.json')), false);
    assert.equal(inputs.some((path) => path.endsWith('/rivu.db')), false);

    const first = createBuildInfo(root, fixedDate);
    writeFileSync(join(root, BUILD_INFO_RELATIVE_PATH), JSON.stringify({ buildId: 'different-generated-value' }));
    const second = createBuildInfo(root, fixedDate);
    assert.deepEqual(second, first);
    assert.equal(first.buildId, first.sourceHash);
    assert.equal(first.buildDate, fixedDate.toISOString());

    writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 2;');
    const changed = createBuildInfo(root, fixedDate);
    assert.notEqual(changed.buildId, first.buildId);
    assert.notEqual(changed.sourceHash, first.sourceHash);
    assert.equal(changed.schemaVersion, 44);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostics bridge is issuer protected and exposes runtime identity', () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const mainSource = readFileSync(join(projectRoot, 'electron', 'main.ts'), 'utf8');
  const preloadSource = readFileSync(join(projectRoot, 'electron', 'preload.ts'), 'utf8');
  const start = mainSource.indexOf("ipcMain.handle('rivu:diagnostics'");
  const end = mainSource.indexOf("ipcMain.handle('rivu:window-theme'", start);
  assert.ok(start >= 0 && end > start);
  const diagnosticsHandler = mainSource.slice(start, end);
  assert.match(diagnosticsHandler, /assertRendererIssuer\(event\)/);
  assert.match(diagnosticsHandler, /SCHEMA_VERSION/);
  assert.match(diagnosticsHandler, /process\.versions/);
  assert.match(diagnosticsHandler, /projectUndiciVersion/);
  assert.match(preloadSource, /diagnostics:\(\)=>ipcRenderer\.invoke\('rivu:diagnostics'\)/);
});
