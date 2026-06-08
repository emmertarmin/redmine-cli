import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RedmineRequestTraceSource = "network" | "cache";

export type RedmineRequestTraceEvent = {
  ts: string;
  method: "GET";
  path: string;
  source: RedmineRequestTraceSource;
  status?: number;
  duration_ms?: number;
  ok?: boolean;
  error?: string;
  cache_age_ms?: number;
};

function getDefaultTraceFilePath(): string {
  const baseDir = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(baseDir, "redmine", "requests.jsonl");
}

function getTraceFilePath(): string | undefined {
  return process.env.REDMINE_TRACE_FILE === "1" ? getDefaultTraceFilePath() : undefined;
}

export async function traceRedmineRequest(event: RedmineRequestTraceEvent): Promise<void> {
  const traceFilePath = getTraceFilePath();
  if (!traceFilePath) {
    return;
  }

  try {
    await mkdir(dirname(traceFilePath), { recursive: true });
    await appendFile(traceFilePath, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Request tracing must never make Redmine commands fail.
  }
}

export function getRedmineTraceFilePath(): string {
  return getDefaultTraceFilePath();
}
