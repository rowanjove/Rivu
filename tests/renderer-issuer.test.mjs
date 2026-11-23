import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

test('renderer issuer allows only the exact app document', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rivu-renderer-issuer-'));
  const output = join(directory, 'renderer-issuer.mjs');
  try {
    await build({
      entryPoints: ['electron/renderer-issuer.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: output,
      logLevel: 'silent',
    });
    const issuer = await import(`${pathToFileURL(output).href}?case=${Date.now()}`);
    const packaged = issuer.expectedRendererUrl(true, 'C:\\Rivu\\resources\\app.asar\\dist-electron');
    assert.equal(packaged, 'file:///C:/Rivu/resources/app.asar/dist/index.html');
    assert.equal(issuer.isAuthorizedRendererUrl(packaged, packaged), true);
    assert.equal(issuer.isAuthorizedRendererUrl(`${packaged}#/settings`, packaged), true);
    assert.equal(issuer.isAuthorizedRendererUrl(`${packaged}?probe=1`, packaged), false);
    assert.equal(issuer.isAuthorizedRendererUrl('file:///C:/Users/public/issuer-probe.html', packaged), false);
    assert.equal(issuer.isAuthorizedRendererUrl('http://127.0.0.1:5173/', packaged), false);

    const development = issuer.expectedRendererUrl(false, 'ignored');
    assert.equal(development, 'http://127.0.0.1:5173/');
    assert.equal(issuer.isAuthorizedRendererUrl(development, development), true);
    assert.equal(issuer.isAuthorizedRendererUrl(`${development}#/settings`, development), true);
    assert.equal(issuer.isAuthorizedRendererUrl('http://127.0.0.1:5173/evil', development), false);
    assert.equal(issuer.isAuthorizedRendererUrl('http://localhost:5173/', development), false);
    assert.equal(issuer.isAuthorizedRendererUrl(`${development}?probe=1`, development), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
