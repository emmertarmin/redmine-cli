import { configCommand } from "../commands/config.js";
import { issueCommand } from "../commands/issues.js";
import type { CommandDefinition, FlagDefinition } from "./types.js";

export const globalFlags: FlagDefinition[] = [
  {
    name: "help",
    aliases: ["h"],
    type: "boolean",
    description: "Show help",
  },
  {
    name: "version",
    aliases: ["v"],
    type: "boolean",
    description: "Show version",
  },
];

export const rootCommand: CommandDefinition = {
  name: "redmine",
  summary: "Redmine CLI",
  description: "Inspect and manage Redmine resources from the command line.",
  subcommands: [configCommand, issueCommand],
};

export function getVisibleSubcommands(command: CommandDefinition): CommandDefinition[] {
  return (command.subcommands ?? []).filter((entry) => entry.hidden !== true);
}

export function findSubcommand(command: CommandDefinition, name: string): CommandDefinition | undefined {
  return (command.subcommands ?? []).find((entry) => entry.name === name || (entry.aliases ?? []).includes(name));
}

export function resolveCommandPath(args: string[]) {
  const path: CommandDefinition[] = [];
  let current = rootCommand;
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    if (!token || token.startsWith("-")) {
      break;
    }

    const next = findSubcommand(current, token);
    if (!next) {
      break;
    }

    path.push(next);
    current = next;
    index += 1;
  }

  const nextToken = args[index];
  const unknownCommand = Boolean(path.length > 0 && nextToken && !nextToken.startsWith("-") && (current.subcommands ?? []).length > 0);
  const unknownTopLevelCommand = path.length === 0 && args[0] !== undefined && !args[0].startsWith("-");

  return {
    command: path.at(-1),
    path,
    consumed: index,
    unknownCommand,
    unknownTopLevelCommand,
  };
}

export function collectCommandFlags(command: CommandDefinition | undefined): FlagDefinition[] {
  return [...globalFlags, ...(command?.flags ?? [])];
}
