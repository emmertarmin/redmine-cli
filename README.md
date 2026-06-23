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
  activity - Watch Redmine activity

Run `redmine <command> --help` for command-specific help.
```

### Watch activity

```bash
redmine activity
redmine activity -n 60
redmine activity -o jsonl
redmine activity watch
redmine activity watch -n 5
redmine activity watch -o jsonl
redmine activity watch --verbose
```

`activity` prints recent issue updates and time entries once. Use `-n` / `--minutes` to choose the lookback window, defaulting to 15 minutes.

`activity watch` polls recent activity, prints recent activity on startup, then continues printing new events. Minimal human-readable text is the default output. Use `--verbose` / `-v` for full markdown details. With `-o jsonl`, default output is `{ "text": "..." }`; verbose JSONL emits the full event object.

## License

MIT
