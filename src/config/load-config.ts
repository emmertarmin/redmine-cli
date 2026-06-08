import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expandHomePath, getConfigPath, getDefaultIssueMirrorDir } from "./xdg.js";
import type { AppConfig } from "./types.js";

export async function ensureConfigDir() {
  await mkdir(dirname(getConfigPath()), { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();

  try {
    await access(configPath, fsConstants.R_OK);
  } catch {
    return {};
  }

  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Partial<AppConfig>;

  if (config.url !== undefined && typeof config.url !== "string") {
    throw new Error(`Invalid config in ${configPath}: url must be a string`);
  }
  if (config.key !== undefined && typeof config.key !== "string") {
    throw new Error(`Invalid config in ${configPath}: key must be a string`);
  }
  if (config.issueMirrorDir !== undefined && typeof config.issueMirrorDir !== "string") {
    throw new Error(`Invalid config in ${configPath}: issueMirrorDir must be a string`);
  }

  return config;
}

export function getIssueMirrorDir(config: AppConfig): string {
  return config.issueMirrorDir ? expandHomePath(config.issueMirrorDir) : getDefaultIssueMirrorDir();
}

export async function saveConfig(config: AppConfig) {
  await ensureConfigDir();
  await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
