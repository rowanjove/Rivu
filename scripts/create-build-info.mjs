import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..');
export const BUILD_INFO_RELATIVE_PATH = 'shared/build-info.json';

// Keep this allowlist limited to build inputs. In particular, never walk the
// project root: it may contain user databases, logs, or retained artifacts.
export const HASHED_DIRECTORIES = ['src', 'server', 'electron', 'shared'];
export const HASHED_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'assets/rivu.ico',
  'scripts/create-build-info.mjs',
];

function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function collectDirectoryFiles(root, directory) {
  const result = [];
  const absoluteDirectory = join(root, directory);
  if (!existsSync(absoluteDirectory)) return result;
  const visit = (currentDirectory) => {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const absolutePath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) result.push(absolutePath);
    }
  };
  visit(absoluteDirectory);
  return result;
}

export function collectHashInputs(projectRoot = PROJECT_ROOT) {
  const root = resolve(projectRoot);
  const paths = [];
  for (const directory of HASHED_DIRECTORIES) paths.push(...collectDirectoryFiles(root, directory));
  for (const file of HASHED_FILES) {
    const absolutePath = join(root, file);
    if (isRegularFile(absolutePath)) paths.push(absolutePath);
  }
  return [...new Set(paths)].filter((path) => relative(root, path).replaceAll('\\', '/') !== BUILD_INFO_RELATIVE_PATH).sort((left, right) => {
    const a = relative(root, left).replaceAll('\\', '/');
    const b = relative(root, right).replaceAll('\\', '/');
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function computeSourceHash(projectRoot = PROJECT_ROOT) {
  const root = resolve(projectRoot);
  const hash = createHash('sha256');
  for (const absolutePath of collectHashInputs(root)) {
    const relativePath = relative(root, absolutePath).replaceAll('\\', '/');
    hash.update(relativePath, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(readFileSync(absolutePath));
    hash.update('\n', 'utf8');
  }
  return hash.digest('hex');
}

export function readSchemaVersion(projectRoot = PROJECT_ROOT) {
  const databasePath = join(resolve(projectRoot), 'server', 'database.ts');
  const source = readFileSync(databasePath, 'utf8');
  const match = source.match(/export\s+const\s+SCHEMA_VERSION\s*=\s*(\d+)\s*;/);
  if (!match) throw new Error(`无法从 ${databasePath} 读取 SCHEMA_VERSION`);
  return Number(match[1]);
}

export function createBuildInfo(projectRoot = PROJECT_ROOT, buildDate = new Date()) {
  const root = resolve(projectRoot);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sourceHash = computeSourceHash(root);
  return {
    buildId: sourceHash,
    buildDate: new Date(buildDate).toISOString(),
    sourceHash,
    appVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
    schemaVersion: readSchemaVersion(root),
    hashAlgorithm: 'sha256',
  };
}

export function writeBuildInfo(projectRoot = PROJECT_ROOT, buildDate = new Date()) {
  const root = resolve(projectRoot);
  const outputPath = join(root, BUILD_INFO_RELATIVE_PATH);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buildInfo = createBuildInfo(root, buildDate);
  writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
  return { outputPath, buildInfo };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { outputPath, buildInfo } = writeBuildInfo();
  process.stdout.write(`${outputPath}\n${buildInfo.buildId}\n`);
}
