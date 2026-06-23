import type { CommandDefinition, ParsedValues } from "../cli/types.js";
import { loadConfig } from "../config/load-config.js";
import { redmineGetJson } from "../redmine/client.js";

type OutputFormat = "md" | "jsonl";

type ActivityEvent = {
  key: string;
  ts: string;
  type: "issue_created" | "issue_update" | "time_entry";
  user?: string;
  issue?: number;
  project?: string;
  subject?: string;
  details: string[];
};

type IssueListResponse = {
  issues?: unknown[];
};

type TimeEntriesResponse = {
  time_entries?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function namedReferenceName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = value.name;
  return typeof name === "string" ? name : undefined;
}

function numericId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parseRedmineTimestamp(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseWatchIntervalMinutes(values: ParsedValues): number {
  const raw = optionalString(values.interval) ?? "1";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 0) {
    throw new Error(`Expected --interval to be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function outputFormat(values: ParsedValues): OutputFormat {
  const value = optionalString(values.output) ?? "md";
  if (value !== "md" && value !== "jsonl") {
    throw new Error(`Invalid value for --output: ${value}`);
  }
  return value;
}

function markdownInline(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function compact(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
}

function formatLocalTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function issueLabel(event: ActivityEvent): string {
  return event.issue === undefined ? "" : ` #${event.issue}`;
}

function subjectLabel(event: ActivityEvent): string {
  return event.subject ? ` “${markdownInline(event.subject)}”` : "";
}

function projectLabel(event: ActivityEvent): string {
  return event.project ? ` in **${markdownInline(event.project)}**` : "";
}

function detailsLabel(event: ActivityEvent): string {
  return event.details.length > 0 ? `: ${event.details.map(markdownInline).join("; ")}` : "";
}

function plainInline(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function eventVerb(event: ActivityEvent): string {
  if (event.type === "issue_created") {
    return "created";
  }
  if (event.type === "time_entry") {
    return "logged time on";
  }
  return "updated";
}

function eventToMinimalText(event: ActivityEvent): string {
  const user = event.user ? plainInline(event.user) : "Someone";
  const issue = event.issue === undefined ? "" : ` issue ${event.issue}`;
  const subject = event.subject ? ` ${plainInline(event.subject)}` : "";
  const project = event.project && event.issue === undefined ? ` in ${plainInline(event.project)}` : "";
  return `${user} ${eventVerb(event)}${issue}${subject}${project}`;
}

function eventToMarkdownLine(event: ActivityEvent): string {
  const user = event.user ? `**${markdownInline(event.user)}**` : "someone";
  const prefix = `- ${formatLocalTimestamp(event.ts)} — ${user}`;

  if (event.type === "issue_created") {
    return `${prefix} created${issueLabel(event)}${subjectLabel(event)}${projectLabel(event)}${detailsLabel(event)}\n`;
  }
  if (event.type === "time_entry") {
    return `${prefix} logged time${issueLabel(event)}${subjectLabel(event)}${projectLabel(event)}${detailsLabel(event)}\n`;
  }
  return `${prefix} updated${issueLabel(event)}${subjectLabel(event)}${projectLabel(event)}${detailsLabel(event)}\n`;
}

function eventToOutputLine(event: ActivityEvent, format: OutputFormat, minimal: boolean): string {
  if (minimal) {
    const text = eventToMinimalText(event);
    if (format === "jsonl") {
      return `${JSON.stringify({ text })}\n`;
    }
    return `${text}\n`;
  }

  if (format === "jsonl") {
    return `${JSON.stringify(event)}\n`;
  }
  return eventToMarkdownLine(event);
}

function journalDetails(journal: Record<string, unknown>): string[] {
  const details: string[] = [];
  const note = compact(journal.notes);
  if (note) {
    details.push(`comment: ${note}`);
  }

  const rawDetails = journal.details;
  if (Array.isArray(rawDetails)) {
    for (const detail of rawDetails) {
      if (!isRecord(detail)) {
        continue;
      }
      const name = typeof detail.name === "string" ? detail.name : typeof detail.property === "string" ? detail.property : "field";
      const oldValue = detail.old_value === undefined || detail.old_value === null || detail.old_value === "" ? "∅" : String(detail.old_value);
      const newValue = detail.new_value === undefined || detail.new_value === null || detail.new_value === "" ? "∅" : String(detail.new_value);
      details.push(`${name} ${oldValue} → ${newValue}`);
    }
  }

  return details;
}

async function collectIssueEvents(config: Awaited<ReturnType<typeof loadConfig>>, since: Date): Promise<ActivityEvent[]> {
  const response = (await redmineGetJson(config, {
    path: "/issues.json",
    query: { status_id: "*", sort: "updated_on:desc", limit: 100 },
  })) as IssueListResponse;

  const events: ActivityEvent[] = [];
  const candidateIds: number[] = [];

  for (const issue of response.issues ?? []) {
    if (!isRecord(issue)) {
      continue;
    }
    const updatedOn = parseRedmineTimestamp(issue.updated_on);
    if (!updatedOn || updatedOn < since) {
      continue;
    }

    const id = numericId(issue.id);
    if (id === undefined) {
      continue;
    }
    candidateIds.push(id);

    const createdOn = parseRedmineTimestamp(issue.created_on);
    if (createdOn && createdOn >= since) {
      events.push({
        key: `issue_created:${id}`,
        ts: createdOn.toISOString(),
        type: "issue_created",
        user: namedReferenceName(issue.author),
        issue: id,
        project: namedReferenceName(issue.project),
        subject: typeof issue.subject === "string" ? issue.subject : undefined,
        details: [],
      });
    }
  }

  for (const issueId of candidateIds) {
    const response = await redmineGetJson(config, {
      path: `/issues/${issueId}.json`,
      query: { include: "journals" },
    });
    if (!isRecord(response) || !isRecord(response.issue)) {
      continue;
    }

    const issue = response.issue;
    const journals = issue.journals;
    if (!Array.isArray(journals)) {
      continue;
    }

    for (const journal of journals) {
      if (!isRecord(journal)) {
        continue;
      }
      const createdOn = parseRedmineTimestamp(journal.created_on);
      const journalId = numericId(journal.id);
      if (!createdOn || createdOn < since || journalId === undefined) {
        continue;
      }

      events.push({
        key: `issue_journal:${issueId}:${journalId}`,
        ts: createdOn.toISOString(),
        type: "issue_update",
        user: namedReferenceName(journal.user),
        issue: issueId,
        project: namedReferenceName(issue.project),
        subject: typeof issue.subject === "string" ? issue.subject : undefined,
        details: journalDetails(journal),
      });
    }
  }

  return events;
}

async function collectTimeEntryEvents(config: Awaited<ReturnType<typeof loadConfig>>, since: Date): Promise<ActivityEvent[]> {
  const response = (await redmineGetJson(config, {
    path: "/time_entries.json",
    query: { sort: "created_on:desc", limit: 100 },
  })) as TimeEntriesResponse;

  const events: ActivityEvent[] = [];
  for (const entry of response.time_entries ?? []) {
    if (!isRecord(entry)) {
      continue;
    }
    const createdOn = parseRedmineTimestamp(entry.created_on);
    const id = numericId(entry.id);
    if (!createdOn || createdOn < since || id === undefined) {
      continue;
    }

    const details: string[] = [];
    const hours = typeof entry.hours === "number" ? `${entry.hours}h` : undefined;
    const activity = namedReferenceName(entry.activity);
    const spentOn = typeof entry.spent_on === "string" ? `spent on ${entry.spent_on}` : undefined;
    const comment = compact(entry.comments, 120);
    const summary = [hours, activity, spentOn].filter(Boolean).join(" ");
    if (summary) {
      details.push(summary);
    }
    if (comment) {
      details.push(comment);
    }

    events.push({
      key: `time_entry:${id}`,
      ts: createdOn.toISOString(),
      type: "time_entry",
      user: namedReferenceName(entry.user),
      issue: isRecord(entry.issue) ? numericId(entry.issue.id) : undefined,
      project: namedReferenceName(entry.project),
      subject: undefined,
      details,
    });
  }

  return events;
}

async function collectActivityEvents(config: Awaited<ReturnType<typeof loadConfig>>, since: Date): Promise<ActivityEvent[]> {
  const [issueEvents, timeEntryEvents] = await Promise.all([collectIssueEvents(config, since), collectTimeEntryEvents(config, since)]);
  return [...issueEvents, ...timeEntryEvents].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLookbackMinutes(values: ParsedValues): number {
  const raw = optionalString(values.minutes) ?? "15";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < 1) {
    throw new Error(`Expected --minutes to be a positive integer, got: ${raw}`);
  }
  return parsed;
}

async function printActivityOnce(values: ParsedValues, lookbackMs: number): Promise<void> {
  const config = await loadConfig();
  const format = outputFormat(values);
  const verbose = values.verbose === true;
  const since = new Date(Date.now() - lookbackMs);
  const events = await collectActivityEvents(config, since);

  for (const event of events) {
    process.stdout.write(eventToOutputLine(event, format, !verbose));
  }
}

async function executeActivityWatch(values: ParsedValues): Promise<void> {
  const config = await loadConfig();
  const intervalMinutes = parseWatchIntervalMinutes(values);
  const intervalMs = intervalMinutes === 0 ? 10_000 : intervalMinutes * 60_000;
  const lookbackMs = (intervalMinutes + 5) * 60_000;
  const format = outputFormat(values);
  const verbose = values.verbose === true;
  const seen = new Set<string>();

  console.error(`Watching Redmine activity every ${intervalMinutes === 0 ? "10 seconds" : `${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}`} (lookback: ${Math.round(lookbackMs / 60_000)} minutes). Press Ctrl+C to stop.`);

  while (true) {
    const since = new Date(Date.now() - lookbackMs);
    const events = await collectActivityEvents(config, since);

    for (const event of events) {
      if (seen.has(event.key)) {
        continue;
      }
      seen.add(event.key);
      process.stdout.write(eventToOutputLine(event, format, !verbose));
    }

    await sleep(intervalMs);
  }
}

const activityOutputFlags = [
  {
    name: "output",
    aliases: ["o"],
    type: "string" as const,
    choices: ["md", "jsonl"],
    description: "Output format: md or jsonl",
    defaultValue: "md",
  },
  {
    name: "verbose",
    aliases: ["v"],
    type: "boolean" as const,
    description: "Output full activity details instead of minimal text",
  },
];

export const activityWatchCommand: CommandDefinition = {
  name: "watch",
  requiresConfig: true,
  aliases: ["tail"],
  summary: "Watch recent Redmine activity",
  description: "Poll Redmine for recent issue and time-entry activity and print new events as a feed.",
  flags: [
    {
      name: "interval",
      aliases: ["n"],
      type: "string" as const,
      description: "Positive integer polling interval in minutes",
      defaultValue: "1",
    },
    ...activityOutputFlags,
  ],
  examples: ["redmine activity watch", "redmine activity watch -n 5", "redmine activity watch -o jsonl", "redmine activity watch --verbose"],
  execute: async ({ values, positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }
    await executeActivityWatch(values);
  },
};

export const activityCommand: CommandDefinition = {
  name: "activity",
  requiresConfig: true,
  summary: "Show recent Redmine activity",
  description: "Show recent Redmine issue and time-entry activity once, or watch it as a feed.",
  flags: [
    {
      name: "minutes",
      aliases: ["n"],
      type: "string" as const,
      description: "Look back this many minutes",
      defaultValue: "15",
    },
    ...activityOutputFlags,
  ],
  examples: ["redmine activity", "redmine activity -n 60", "redmine activity -o jsonl", "redmine activity --verbose", "redmine activity watch"],
  subcommands: [activityWatchCommand],
  execute: async ({ values, positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }
    await printActivityOnce(values, parseLookbackMinutes(values) * 60_000);
  },
};
