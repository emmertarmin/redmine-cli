# redmine-cli

A small Redmine CLI created for my personal use.

At the moment, it supports configuring a Redmine instance and working with issues from the command line.

## Requirements

- [Bun](https://bun.sh/)

## Install

```bash
bun install -g @emmertarmin/redmine-cli
```

Then run:

```bash
redmine --help
redmine --version
```

## Usage

```text
redmine

Inspect and manage Redmine resources from the command line.

Usage:
  redmine <subcommand>

Options:
  --help, -h
      Show help
  --version, -v
      Show version

Subcommands:
  config - Manage configuration
  issue - Work with issues

Run `redmine <command> --help` for command-specific help.
```

## License

MIT
