import type { AppConfig } from "../config/types.js";
import { readCachedRedmineJson, writeCachedRedmineJson } from "./cache.js";
import { traceRedmineRequest } from "./trace.js";

export type RedmineRequestOptions = {
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
};

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing Redmine ${name}. Run \`redmine config set --${name} <value>\`.`);
  }
  return value;
}

function buildUrl(baseUrl: string, path: string, query: RedmineRequestOptions["query"] = {}) {
  const url = new URL(path.replace(/^\/+/, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

async function fetchRedmineJson(config: AppConfig, url: URL, path: string): Promise<unknown> {
  const key = requireString(config.key, "key");
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Redmine-API-Key": key,
      },
    });
    const durationMs = Math.round(performance.now() - startedAt);

    await traceRedmineRequest({
      ts: new Date().toISOString(),
      method: "GET",
      path,
      source: "network",
      status: response.status,
      duration_ms: durationMs,
      ok: response.ok,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Redmine API request failed (${response.status} ${response.statusText}): ${body}`);
    }

    return response.json();
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("Redmine API request failed"))) {
      await traceRedmineRequest({
        ts: new Date().toISOString(),
        method: "GET",
        path,
        source: "network",
        duration_ms: Math.round(performance.now() - startedAt),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

export async function redmineGetJson(config: AppConfig, options: RedmineRequestOptions): Promise<unknown> {
  const url = buildUrl(requireString(config.url, "url"), options.path, options.query);
  const path = `${url.pathname}${url.search}`;
  return fetchRedmineJson(config, url, path);
}

export async function redmineGetJsonCached(config: AppConfig, options: RedmineRequestOptions, ttlMs: number): Promise<unknown> {
  const url = buildUrl(requireString(config.url, "url"), options.path, options.query);
  const path = `${url.pathname}${url.search}`;
  const startedAt = performance.now();
  const cached = await readCachedRedmineJson(url.toString(), ttlMs);

  if (cached) {
    await traceRedmineRequest({
      ts: new Date().toISOString(),
      method: "GET",
      path,
      source: "cache",
      status: 200,
      duration_ms: Math.round(performance.now() - startedAt),
      ok: true,
      cache_age_ms: Math.round(cached.ageMs),
    });
    return cached.data;
  }

  const data = await fetchRedmineJson(config, url, path);
  await writeCachedRedmineJson(url.toString(), ttlMs, data);
  return data;
}
