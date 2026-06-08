import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigPath() {
  const baseDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(baseDir, "redmine", "config.json");
}

export function getDataDir() {
  const baseDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(baseDir, "redmine");
}

export function getDefaultIssueMirrorDir() {
  return join(getDataDir(), "issues");
}

export function expandHomePath(path: string) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
