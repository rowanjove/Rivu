import { lstat, statfs } from "node:fs/promises";

export const BACKUP_ENTRY_LIMITS = Object.freeze({
  "manifest.json": 64 * 1024,
  "settings.json": 1024 * 1024,
  "rivu.db": 20 * 1024 * 1024 * 1024,
});

export const BACKUP_UNCOMPRESSED_BUDGET = Object.values(
  BACKUP_ENTRY_LIMITS,
).reduce((sum, value) => sum + value, 0);
// The filesystem can allocate in blocks and metadata may be written between
// the check and the first stream write. Keep a small reserve for that race.
export const BACKUP_SPACE_SAFETY_MARGIN = 64 * 1024 * 1024;
export const SQLITE_MIGRATION_RESERVE = 1024 * 1024 * 1024;

export type BackupEntryLike = { fileName: string; uncompressedSize: number };
export type BackupSpacePlan = {
  tempBytes: number;
  targetBytes: number;
  totalUncompressedBytes: number;
  migrationBytes: number;
};

function safeBytes(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${label}无效`);
  return value;
}

export async function regularFileSize(path: string, label = "备份源") {
  const info = await lstat(path);
  if (!info.isFile()) throw Error(`${label}必须是普通文件`);
  if (!Number.isSafeInteger(info.size) || info.size <= 0)
    throw Error(`${label}大小无效`);
  return info.size;
}

export function validateBackupEntries(entries: readonly BackupEntryLike[]) {
  if (
    entries.length === 0 ||
    entries.length > Object.keys(BACKUP_ENTRY_LIMITS).length
  )
    throw Error("备份条目数量无效");
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const limit =
      BACKUP_ENTRY_LIMITS[entry.fileName as keyof typeof BACKUP_ENTRY_LIMITS];
    if (
      !Object.hasOwn(BACKUP_ENTRY_LIMITS, entry.fileName) ||
      seen.has(entry.fileName)
    )
      throw Error("备份含无效、重复或超出大小限制的文件");
    const size = safeBytes(entry.uncompressedSize, "备份条目大小");
    if (size > limit) throw Error("备份含无效、重复或超出大小限制的文件");
    total += size;
    if (total > BACKUP_UNCOMPRESSED_BUDGET)
      throw Error("备份展开总大小超出限制");
    seen.add(entry.fileName);
  }
  if (!seen.has("manifest.json") || !seen.has("rivu.db"))
    throw Error("备份格式无效");
  return { totalUncompressedBytes: total, seen };
}

export function backupSpacePlan({
  sourceBytes = 0,
  totalUncompressedBytes,
  currentDbBytes = 0,
  currentSettingsBytes = 0,
  migrationBytes = 0,
}: {
  sourceBytes?: number;
  totalUncompressedBytes: number;
  currentDbBytes?: number;
  currentSettingsBytes?: number;
  migrationBytes?: number;
}): BackupSpacePlan {
  const source = safeBytes(sourceBytes, "备份源大小");
  const expanded = safeBytes(totalUncompressedBytes, "备份展开总大小");
  const db = safeBytes(currentDbBytes, "当前数据库大小");
  const settings = safeBytes(currentSettingsBytes, "当前设置大小");
  const migration = safeBytes(migrationBytes, "迁移快照预留");
  const tempBytes = source + BACKUP_SPACE_SAFETY_MARGIN;
  // The restore extraction directory is in the target directory. This budget
  // therefore includes the extracted files, rollback copies and migration
  // snapshot space before any stream is opened.
  const targetBytes =
    expanded + db + settings + migration + BACKUP_SPACE_SAFETY_MARGIN;
  return {
    tempBytes,
    targetBytes,
    totalUncompressedBytes: expanded,
    migrationBytes: migration,
  };
}

export function assertAvailableSpace(
  plan: BackupSpacePlan,
  available: { temp?: number; target?: number },
) {
  const check = (name: string, required: number, value: number | undefined) => {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < required)
    )
      throw Error(`${name}可用空间不足，需要至少 ${required} 字节`);
  };
  check("备份临时目录", plan.tempBytes, available.temp);
  check("恢复目标目录", plan.targetBytes, available.target);
}

export async function availableBytes(path: string) {
  try {
    const info = await statfs(path, { bigint: true });
    const bytes = info.bavail * info.bsize;
    return bytes <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(bytes)
      : Number.MAX_SAFE_INTEGER;
  } catch (error) {
    // Some network/filesystem providers do not expose statfs. The subsequent
    // write still has normal error and cleanup handling, so keep compatibility
    // rather than rejecting every backup on an unknown filesystem.
    if (
      ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      return undefined;
    throw error;
  }
}

export async function assertBackupSpace({
  tempDirectory,
  targetDirectory,
  sourceBytes = 0,
  totalUncompressedBytes,
  currentDbBytes = 0,
  currentSettingsBytes = 0,
  migrationBytes = 0,
}: {
  tempDirectory: string;
  targetDirectory?: string;
  sourceBytes?: number;
  totalUncompressedBytes: number;
  currentDbBytes?: number;
  currentSettingsBytes?: number;
  migrationBytes?: number;
}) {
  const plan = backupSpacePlan({
    sourceBytes,
    totalUncompressedBytes,
    currentDbBytes,
    currentSettingsBytes,
    migrationBytes,
  });
  const targetPath = targetDirectory ?? tempDirectory;
  const [temp, target] = await Promise.all([
    availableBytes(tempDirectory),
    targetPath === tempDirectory
      ? Promise.resolve(undefined)
      : availableBytes(targetPath),
  ]);
  assertAvailableSpace(plan, {
    temp,
    target: targetPath === tempDirectory ? temp : target,
  });
  return plan;
}
