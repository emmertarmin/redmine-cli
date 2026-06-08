import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CacheEntry = {
  createdAt: string;
  ttlMs: number;
  data: unknown;
};

function getCacheDir(): string {
  const baseDir = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(baseDir, "redmine", "api-cache-v1");
}

function cachePathForKey(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(getCacheDir(), `${hash}.json`);
}

export async function readCachedRedmineJson(key: string, ttlMs: number): Promise<{ data: unknown; ageMs: number } | undefined> {
  try {
    const raw = await readFile(cachePathForKey(key), "utf8");
    const entry = JSON.parse(raw) as Partial<CacheEntry>;
    if (typeof entry.createdAt !== "string" || !("data" in entry)) {
      return undefined;
    }

    const createdAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdAt)) {
      return undefined;
    }

    const ageMs = Date.now() - createdAt;
    if (ageMs < 0 || ageMs > ttlMs) {
      return undefined;
    }

    return { data: entry.data, ageMs };
  } catch {
    return undefined;
  }
}

export async function writeCachedRedmineJson(key: string, ttlMs: number, data: unknown): Promise<void> {
  try {
    await mkdir(getCacheDir(), { recursive: true });
    const entry: CacheEntry = {
      createdAt: new Date().toISOString(),
      ttlMs,
      data,
    };
    await writeFile(cachePathForKey(key), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Caching must never make Redmine commands fail.
  }
}
