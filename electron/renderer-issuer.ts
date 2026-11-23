import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEVELOPMENT_RENDERER_URL = 'http://127.0.0.1:5173/';

/** Return the only URL that the main application renderer is allowed to use. */
export function expectedRendererUrl(isPackaged: boolean, mainDirectory: string): string {
  return isPackaged
    ? pathToFileURL(join(mainDirectory, '../dist/index.html')).href
    : DEVELOPMENT_RENDERER_URL;
}

/** Hash routes stay in the same trusted document; queries are intentionally not allowed. */
export function isAuthorizedRendererUrl(url: string, expectedUrl: string): boolean {
  const hashIndex = url.indexOf('#');
  return (hashIndex === -1 ? url : url.slice(0, hashIndex)) === expectedUrl;
}
