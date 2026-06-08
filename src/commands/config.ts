import type { CommandDefinition } from "../cli/types.js";
import { getIssueMirrorDir, loadConfig, saveConfig } from "../config/load-config.js";
import { getConfigPath } from "../config/xdg.js";
import type { AppConfig } from "../config/types.js";

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "*****";
  }

  return `*****${key.slice(-4)}`;
}

function maskConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    key: config.key === undefined ? undefined : maskApiKey(config.key),
  };
}

export const configGetCommand: CommandDefinition = {
  name: "get",
  summary: "Get Redmine configuration values",
  description: "Print a single Redmine setting from the XDG config file.",
  flags: [
    {
      name: "url",
      type: "boolean",
      description: "Print the configured Redmine server URL",
    },
    {
      name: "key",
      type: "boolean",
      description: "Print the configured Redmine API key, obfuscated for identification",
    },
    {
      name: "issue-mirror-dir",
      type: "boolean",
      description: "Print the configured issue mirror directory, or the default if unset",
    },
  ],
  examples: ["redmine config get --url", "redmine config get --key", "redmine config get --issue-mirror-dir"],
  execute: async ({ values, positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }

    const wantsUrl = values.url === true;
    const wantsKey = values.key === true;
    const wantsIssueMirrorDir = values["issue-mirror-dir"] === true;

    if ([wantsUrl, wantsKey, wantsIssueMirrorDir].filter(Boolean).length !== 1) {
      throw new Error("Specify exactly one setting to get: --url, --key, or --issue-mirror-dir.");
    }

    const config = await loadConfig();
    if (wantsIssueMirrorDir) {
      console.log(getIssueMirrorDir(config));
      return;
    }

    const name = wantsUrl ? "url" : "key";
    const value = config[name];

    if (value === undefined) {
      throw new Error(`Config value is not set: ${name}`);
    }

    console.log(name === "key" ? maskApiKey(value) : value);
  },
};

export const configListCommand: CommandDefinition = {
  name: "list",
  aliases: ["ls"],
  summary: "List Redmine configuration",
  description: "Print all configured Redmine settings from the XDG config file.",
  examples: ["redmine config list"],
  execute: async ({ positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }

    const config = await loadConfig();
    console.log(JSON.stringify(maskConfig(config), null, 2));
  },
};

export const configSetCommand: CommandDefinition = {
  name: "set",
  summary: "Set Redmine configuration",
  description: "Write Redmine connection settings to the XDG config file.",
  flags: [
    {
      name: "url",
      type: "string",
      description: "Redmine server URL",
    },
    {
      name: "key",
      type: "string",
      description: "Redmine API key",
    },
    {
      name: "issue-mirror-dir",
      type: "string",
      description: "Directory for the local Markdown issue mirror",
    },
  ],
  examples: ["redmine config set --url https://redmine.example.com --key YOUR_API_KEY", "redmine config set --issue-mirror-dir ~/Documents/Redmine"],
  execute: async ({ values, positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }

    const url = optionalString(values.url);
    const key = optionalString(values.key);
    const issueMirrorDir = optionalString(values["issue-mirror-dir"]);

    if (url === undefined && key === undefined && issueMirrorDir === undefined) {
      throw new Error("Nothing to set. Provide --url, --key, --issue-mirror-dir, or any combination.");
    }

    const nextConfig: AppConfig = {
      ...(await loadConfig()),
    };

    if (url !== undefined) {
      nextConfig.url = url;
    }
    if (key !== undefined) {
      nextConfig.key = key;
    }
    if (issueMirrorDir !== undefined) {
      nextConfig.issueMirrorDir = issueMirrorDir;
    }

    await saveConfig(nextConfig);
    console.log(`Wrote ${getConfigPath()}`);
  },
};

export const configCommand: CommandDefinition = {
  name: "config",
  summary: "Manage configuration",
  description: "Commands for Redmine settings stored in the XDG config file.",
  subcommands: [configGetCommand, configSetCommand, configListCommand],
};
