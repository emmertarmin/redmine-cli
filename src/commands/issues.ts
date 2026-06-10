import { createInterface } from "node:readline/promises";
import { stdin as input, stderr as output } from "node:process";
import type { CommandDefinition, ParsedValues } from "../cli/types.js";
import { loadConfig } from "../config/load-config.js";
import { redmineGetJson, redmineGetJsonCached } from "../redmine/client.js";
import { renderMarkdownForTerminal } from "../output/markdown.js";

const SPRINT_CUSTOM_FIELD_ID = 10;
const SPRINT_ANCHOR_START = "2026-06-08";
const SPRINT_ANCHOR_NUMBER = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const SPRINT_DAYS = 14;
const SPRINT_WORK_DAYS = 12;
const DESCRIPTION_PREVIEW_LENGTH = 180;
const DESCRIPTION_PREVIEW_HYSTERESIS_LENGTH = 220;
const DEFAULT_ISSUE_GET_INCLUDE = "journals,attachments,relations,changesets,watchers";

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: string | boolean | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a numeric value");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function requirePositiveInteger(value: string | undefined, name: string): number {
  if (!value) {
    throw new Error(`Expected ${name}`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1) {
    throw new Error(`Expected ${name} to be a positive integer, got: ${value}`);
  }
  return parsed;
}

type IssueListResponse = {
  issues: unknown[];
  total_count: number;
  offset: number;
  limit: number;
};

type NamedReference = {
  id?: unknown;
  name?: unknown;
};

type RedmineConfig = Awaited<ReturnType<typeof loadConfig>>;

type LookupMaps = {
  statuses: Map<string, string>;
  trackers: Map<string, string>;
  priorities: Map<string, string>;
  customFields: Map<string, string>;
  versions: Map<string, string>;
  categories: Map<string, string>;
  users: Map<string, string>;
};

type EnrichmentData = {
  lookups: LookupMaps;
  timeEntries?: unknown[];
  warnings: string[];
};

type IssueSummary = {
  id?: unknown;
  subject?: unknown;
  project?: string;
  tracker?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  author?: string;
  sprint?: string;
  description_preview?: string;
  updated_on?: unknown;
  created_on?: unknown;
  spent_hours?: unknown;
  estimated_hours?: unknown;
  done_ratio?: unknown;
};

type SprintFilter =
  | { kind: "exact"; value: string }
  | { kind: "past" }
  | { kind: "future" };

type IssueListFilters = {
  project?: string;
  assignee?: string;
  status: string;
  sprint?: SprintFilter;
};

function isIssueListResponse(value: unknown): value is IssueListResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const response = value as Partial<IssueListResponse>;
  return Array.isArray(response.issues) && typeof response.total_count === "number" && typeof response.offset === "number" && typeof response.limit === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function namedReferenceName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = (value as NamedReference).name;
  if (typeof name === "string") {
    return name;
  }

  const firstName = value.firstname;
  const lastName = value.lastname;
  if (typeof firstName === "string" && typeof lastName === "string") {
    return `${lastName}, ${firstName}`;
  }

  const login = value.login;
  return typeof login === "string" ? login : undefined;
}

function namedReferenceId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = (value as NamedReference).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function createLookupMaps(): LookupMaps {
  return {
    statuses: new Map(),
    trackers: new Map(),
    priorities: new Map(),
    customFields: new Map(),
    versions: new Map(),
    categories: new Map(),
    users: new Map(),
  };
}

function addNamedReferencesToMap(map: Map<string, string>, values: unknown): void {
  if (!Array.isArray(values)) {
    return;
  }

  for (const value of values) {
    const id = namedReferenceId(value);
    const name = namedReferenceName(value);
    if (id && name) {
      map.set(id, name);
    }
  }
}

function lookupArray(response: unknown, key: string): unknown {
  return isRecord(response) ? response[key] : undefined;
}

function mergeLookupMaps(target: LookupMaps, source: LookupMaps): void {
  for (const [key, map] of Object.entries(source) as [keyof LookupMaps, Map<string, string>][]) {
    for (const [id, name] of map) {
      target[key].set(id, name);
    }
  }
}

function truncateDescription(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= DESCRIPTION_PREVIEW_HYSTERESIS_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, DESCRIPTION_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

function summarizeIssue(issue: unknown): IssueSummary {
  if (!issue || typeof issue !== "object") {
    return {};
  }

  const record = issue as Record<string, unknown>;
  return {
    id: record.id,
    subject: record.subject,
    project: namedReferenceName(record.project),
    tracker: namedReferenceName(record.tracker),
    status: namedReferenceName(record.status),
    priority: namedReferenceName(record.priority),
    assignee: namedReferenceName(record.assigned_to),
    author: namedReferenceName(record.author),
    sprint: getIssueSprintValue(issue) || undefined,
    description_preview: truncateDescription(record.description),
    updated_on: record.updated_on,
    created_on: record.created_on,
    spent_hours: record.spent_hours,
    estimated_hours: record.estimated_hours,
    done_ratio: record.done_ratio,
  };
}

function summarizeIssueListResponse(response: IssueListResponse, issues = response.issues): IssueListResponse & { issues: IssueSummary[] } {
  return {
    ...response,
    issues: issues.map((issue) => summarizeIssue(issue)),
  };
}

type OutputFormat = "json" | "md";

function outputFormat(values: ParsedValues): OutputFormat {
  const value = optionalString(values.output) ?? "json";
  if (value !== "json" && value !== "md") {
    throw new Error(`Invalid value for --output: ${value}`);
  }
  return value;
}

function mdEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function scalarValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const name = namedReferenceName(value);
  if (name) {
    return name;
  }
  return undefined;
}

function formatDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function formatHours(value: unknown): string | undefined {
  if (typeof value !== "number") {
    return scalarValue(value);
  }
  return `${value}h`;
}

function normalizeRedmineTextileToMarkdown(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const codeBlocks: string[] = [];
  const protectCodeBlock = (_match: string, language: string | undefined, body: string) => {
    const index = codeBlocks.push(`\n\n\`\`\`${language ? language.trim() : ""}\n${body.replace(/^\n|\n$/g, "")}\n\`\`\`\n\n`) - 1;
    return `\n\n@@REDMINE_CODE_BLOCK_${index}@@\n\n`;
  };

  let text = value
    .replace(/\r\n/g, "\n")
    .replace(/<pre><code(?:\s+class=["']?([^"'>\s]+)["']?)?>([\s\S]*?)<\/code><\/pre>/gi, protectCodeBlock)
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, (_match, body: string) => protectCodeBlock("", undefined, body))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/^h([1-6])\.\s+/gm, (_, level: string) => `${"#".repeat(Number.parseInt(level, 10))} `)
    .replace(/^bq\.\s+/gm, "> ")
    .replace(/^p[<>=(){}\[\]#.\w-]*\.\s+/gm, "")
    .replace(/(^|[\s([{])\*([^*\n]+)\*(?=[\s).,!?:;\]}]|$)/g, "$1**$2**")
    .replace(/\+([^+\n]+)\+/g, "$1")
    .replace(/"([^"\n]+)":(https?:\/\/\S+)/g, "[$1]($2)")
    .replace(/@([^@\n]+)@/g, "`$1`")
    .replace(/\{\{(?:toc|>toc)\}\}/gi, "")
    .trim();

  text = text.replace(/@@REDMINE_CODE_BLOCK_(\d+)@@/g, (_match, index: string) => codeBlocks[Number.parseInt(index, 10)] ?? "");
  return text || undefined;
}

function markdownTable(rows: [string, string | undefined][]): string {
  const presentRows = rows.filter(([, value]) => value !== undefined && value !== "");
  if (presentRows.length === 0) {
    return "";
  }

  return ["| Field | Value |", "| --- | --- |", ...presentRows.map(([label, value]) => `| ${mdEscape(label)} | ${mdEscape(value)} |`)].join("\n");
}

function customFieldsMarkdown(issue: Record<string, unknown>): string {
  if (!Array.isArray(issue.custom_fields)) {
    return "";
  }

  const rows = issue.custom_fields
    .filter((field): field is Record<string, unknown> => isRecord(field))
    .map((field): [string, string | undefined] => [scalarValue(field.name) ?? `Custom field ${scalarValue(field.id) ?? ""}`.trim(), scalarValue(field.value)]);

  return markdownTable(rows);
}

function yamlString(value: unknown): string {
  return JSON.stringify(String(value ?? ""));
}

function joinNameAndId(value: unknown): string | undefined {
  const name = namedReferenceName(value);
  const id = namedReferenceId(value);
  if (name && id) return `${name} (#${id})`;
  return name ?? id;
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "";
}

function compactJson(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function summarizeChangedText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return compactJson(value);
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  return `${normalized.length} chars${normalized.length <= 80 ? `: ${normalized}` : ""}`;
}

function journalDetailMarkdown(detail: Record<string, unknown>): string {
  const label = scalarValue(detail.label) ?? scalarValue(detail.name) ?? "Change";
  const oldValue = scalarValue(detail.old_label) ?? compactJson(detail.old_value);
  const newValue = scalarValue(detail.new_label) ?? compactJson(detail.new_value);
  const property = scalarValue(detail.property);
  const suffix = property && property !== "attr" ? ` (${mdEscape(property)})` : "";

  if (detail.name === "description" || detail.name === "notes") {
    const oldSummary = summarizeChangedText(detail.old_value);
    const newSummary = summarizeChangedText(detail.new_value);
    const summary = [oldSummary ? `previous ${oldSummary}` : undefined, newSummary ? `updated ${newSummary}` : undefined].filter(Boolean).join("; ");
    return `- **${mdEscape(label)}${suffix}:** changed${summary ? ` (${mdEscape(summary)})` : ""}`;
  }

  const maxInlineLength = 160;
  const oldInline = oldValue && oldValue.length > maxInlineLength ? `${oldValue.slice(0, maxInlineLength - 1).trimEnd()}…` : oldValue;
  const newInline = newValue && newValue.length > maxInlineLength ? `${newValue.slice(0, maxInlineLength - 1).trimEnd()}…` : newValue;

  if (oldInline !== undefined && newInline !== undefined) {
    return `- **${mdEscape(label)}${suffix}:** \`${mdEscape(oldInline)}\` → \`${mdEscape(newInline)}\``;
  }
  if (newInline !== undefined) {
    return `- **${mdEscape(label)}${suffix}:** set to \`${mdEscape(newInline)}\``;
  }
  if (oldInline !== undefined) {
    return `- **${mdEscape(label)}${suffix}:** removed \`${mdEscape(oldInline)}\``;
  }
  return `- **${mdEscape(label)}${suffix}** changed`;
}

function issueResponseToMarkdown(response: unknown): string {
  const issue = isRecord(response) && isRecord(response.issue) ? response.issue : undefined;
  if (!issue) {
    return `---\nresource: redmine_issue\ngenerated_at: ${new Date().toISOString()}\n---\n\n# Redmine issue\n\n\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\`\n`;
  }

  const id = scalarValue(issue.id) ?? "?";
  const subject = scalarValue(issue.subject) ?? "Untitled issue";
  const frontmatter = [
    "resource: redmine_issue",
    `id: ${yamlString(id)}`,
    `subject: ${yamlString(subject)}`,
    `project: ${yamlString(namedReferenceName(issue.project) ?? "")}`,
    `status: ${yamlString(namedReferenceName(issue.status) ?? "")}`,
    `generated_at: ${new Date().toISOString()}`,
  ];

  const parts = [`---\n${frontmatter.join("\n")}\n---`, `# #${mdEscape(id)} ${mdEscape(subject)}`];
  const sprint = getIssueSprintValue(issue);
  const overview = markdownTable([
    ["Project", joinNameAndId(issue.project)],
    ["Tracker", joinNameAndId(issue.tracker)],
    ["Status", joinNameAndId(issue.status)],
    ["Priority", joinNameAndId(issue.priority)],
    ["Category", joinNameAndId(issue.category)],
    ["Target version", joinNameAndId(issue.fixed_version)],
    ["Parent", joinNameAndId(issue.parent)],
    ["Assignee", joinNameAndId(issue.assigned_to)],
    ["Author", joinNameAndId(issue.author)],
    ["Sprint", sprint],
    ["Done", scalarValue(issue.done_ratio) ? `${scalarValue(issue.done_ratio)}%` : undefined],
    ["Estimated", formatHours(issue.estimated_hours)],
    ["Spent", formatHours(issue.spent_hours)],
    ["Total spent", formatHours(issue.total_spent_hours)],
    ["Start", scalarValue(issue.start_date)],
    ["Due", scalarValue(issue.due_date)],
    ["Created", formatDateTime(issue.created_on)],
    ["Updated", formatDateTime(issue.updated_on)],
    ["Closed", formatDateTime(issue.closed_on)],
    ["Private", issue.is_private === true ? "yes" : undefined],
  ]);
  if (overview) parts.push("## Overview", overview);

  const description = normalizeRedmineTextileToMarkdown(issue.description);
  if (description) parts.push("## Description", description);

  const customFields = customFieldsMarkdown(issue);
  if (customFields) parts.push("## Custom fields", customFields);

  if (Array.isArray(issue.attachments) && issue.attachments.length > 0) {
    const items = issue.attachments.filter(isRecord).map((attachment) => {
      const filename = scalarValue(attachment.filename) ?? scalarValue(attachment.id) ?? "attachment";
      const url = scalarValue(attachment.content_url);
      const author = namedReferenceName(attachment.author);
      const size = scalarValue(attachment.filesize);
      const meta = [size ? `${size} bytes` : undefined, author ? `by ${author}` : undefined, formatDateTime(attachment.created_on)].filter(Boolean).join(", ");
      return `${url ? `[${mdEscape(filename)}](${url})` : mdEscape(filename)}${meta ? ` — ${mdEscape(meta)}` : ""}`;
    });
    parts.push("## Attachments", bulletList(items));
  }

  if (Array.isArray(issue.relations) && issue.relations.length > 0) {
    const rows = issue.relations.filter(isRecord).map((relation) => [
      scalarValue(relation.relation_type) ?? "relation",
      `#${scalarValue(relation.issue_id) ?? "?"} ↔ #${scalarValue(relation.issue_to_id) ?? "?"}${scalarValue(relation.delay) ? ` (${scalarValue(relation.delay)}d)` : ""}`,
    ] as [string, string | undefined]);
    parts.push("## Relations", markdownTable(rows));
  }

  if (Array.isArray(issue.children) && issue.children.length > 0) {
    const items = issue.children.filter(isRecord).map((child) => `#${scalarValue(child.id) ?? "?"} ${mdEscape(scalarValue(child.subject) ?? "Untitled")} — ${mdEscape(namedReferenceName(child.status) ?? "")}`.trim());
    parts.push("## Children", bulletList(items));
  }

  if (Array.isArray(issue.changesets) && issue.changesets.length > 0) {
    const items = issue.changesets.filter(isRecord).map((changeset) => {
      const revision = scalarValue(changeset.revision) ?? scalarValue(changeset.id) ?? "changeset";
      const comments = scalarValue(changeset.comments);
      const author = scalarValue(changeset.user) ?? scalarValue(changeset.author);
      const committed = formatDateTime(changeset.committed_on);
      return [`\`${mdEscape(revision)}\``, author, committed, comments].filter(Boolean).join(" — ");
    });
    parts.push("## Changesets", bulletList(items));
  }

  if (Array.isArray(issue.watchers) && issue.watchers.length > 0) {
    parts.push("## Watchers", bulletList(issue.watchers.map((watcher) => mdEscape(joinNameAndId(watcher) ?? compactJson(watcher) ?? "watcher"))));
  }

  if (Array.isArray(issue.time_entries) && issue.time_entries.length > 0) {
    const rows = issue.time_entries.filter(isRecord).map((entry) => [
      scalarValue(entry.spent_on) ?? formatDateTime(entry.created_on) ?? "time entry",
      [formatHours(entry.hours), namedReferenceName(entry.user), namedReferenceName(entry.activity), scalarValue(entry.comments)].filter(Boolean).join(" — "),
    ] as [string, string | undefined]);
    parts.push("## Time entries", markdownTable(rows));
  }

  if (Array.isArray(issue.journals) && issue.journals.length > 0) {
    parts.push("## Journal");
    for (const journal of issue.journals.filter(isRecord)) {
      const journalId = scalarValue(journal.id) ?? "?";
      const author = namedReferenceName(journal.user) ?? "Unknown user";
      const created = formatDateTime(journal.created_on) ?? scalarValue(journal.created_on) ?? "unknown date";
      parts.push(`### Note ${mdEscape(journalId)} — ${mdEscape(author)} — ${mdEscape(created)}`);
      const notes = normalizeRedmineTextileToMarkdown(journal.notes);
      if (notes) parts.push(notes);
      if (Array.isArray(journal.details) && journal.details.length > 0) {
        const detailBlocks = journal.details.filter(isRecord).map(journalDetailMarkdown);
        parts.push(detailBlocks.join("\n"));
      }
    }
  }

  if (isRecord(issue._enrichment) && Array.isArray(issue._enrichment.warnings) && issue._enrichment.warnings.length > 0) {
    parts.push("## Enrichment warnings", bulletList(issue._enrichment.warnings.map((warning) => mdEscape(compactJson(warning) ?? "warning"))));
  }

  const renderedKeys = new Set([
    "id", "subject", "project", "tracker", "status", "priority", "category", "fixed_version", "parent", "assigned_to", "author", "custom_fields", "custom_fields_by_name", "done_ratio", "estimated_hours", "spent_hours", "total_spent_hours", "start_date", "due_date", "created_on", "updated_on", "closed_on", "is_private", "description", "attachments", "relations", "children", "changesets", "watchers", "time_entries", "journals", "_enrichment",
  ]);
  const additionalData = Object.fromEntries(Object.entries(issue).filter(([key]) => !renderedKeys.has(key)));
  if (Object.keys(additionalData).length > 0) {
    parts.push("## Additional data", `\`\`\`json\n${JSON.stringify(additionalData, null, 2)}\n\`\`\``);
  }

  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function issueListResponseToMarkdown(response: IssueListResponse, filters: IssueListFilters): string {
  const fetchedCount = response.issues.length;
  const complete = response.offset + fetchedCount >= response.total_count;
  const frontmatter = [
    "resource: redmine_issue_list",
    `total_count: ${response.total_count}`,
    `fetched_count: ${fetchedCount}`,
    `offset: ${response.offset}`,
    `limit: ${response.limit}`,
    `complete: ${complete}`,
    `generated_at: ${new Date().toISOString()}`,
  ];

  const activeFilters = [
    filters.project ? `project=${filters.project}` : undefined,
    filters.assignee ? `assignee=${filters.assignee}` : undefined,
    filters.status ? `status=${filters.status}` : undefined,
    filters.sprint ? `sprint=${filters.sprint.kind === "exact" ? filters.sprint.value : filters.sprint.kind}` : undefined,
  ].filter(Boolean);

  const parts = [`---\n${frontmatter.join("\n")}\n---`, "# Redmine issues", `Fetched **${fetchedCount}** of **${response.total_count}** issues${complete ? "." : " (partial result)."}`];
  if (activeFilters.length > 0) {
    parts.push(`Filters: ${activeFilters.map((filter) => `\`${filter}\``).join(", ")}`);
  }

  for (const issue of response.issues) {
    if (!isRecord(issue)) {
      continue;
    }

    const id = scalarValue(issue.id) ?? "?";
    const subject = scalarValue(issue.subject) ?? "Untitled issue";
    const sprint = getIssueSprintValue(issue);
    const fields = markdownTable([
      ["Project", scalarValue(issue.project)],
      ["Tracker", scalarValue(issue.tracker)],
      ["Status", scalarValue(issue.status)],
      ["Priority", scalarValue(issue.priority)],
      ["Assignee", scalarValue(issue.assigned_to)],
      ["Author", scalarValue(issue.author)],
      ["Sprint", sprint],
      ["Done", scalarValue(issue.done_ratio) ? `${scalarValue(issue.done_ratio)}%` : undefined],
      ["Estimated", formatHours(issue.estimated_hours)],
      ["Spent", formatHours(issue.spent_hours)],
      ["Total spent", formatHours(issue.total_spent_hours)],
      ["Start", scalarValue(issue.start_date)],
      ["Due", scalarValue(issue.due_date)],
      ["Created", formatDateTime(issue.created_on)],
      ["Updated", formatDateTime(issue.updated_on)],
      ["Closed", formatDateTime(issue.closed_on)],
      ["Private", issue.is_private === true ? "yes" : undefined],
    ]);

    parts.push(`## #${mdEscape(id)} ${mdEscape(subject)}`);
    if (fields) {
      parts.push(fields);
    }

    const description = normalizeRedmineTextileToMarkdown(issue.description);
    if (description) {
      parts.push("### Description", description);
    }

    const customFields = customFieldsMarkdown(issue);
    if (customFields) {
      parts.push("### Custom fields", customFields);
    }
  }

  return `${parts.join("\n\n")}\n`;
}

function printIssueListResponse(response: IssueListResponse, values: ParsedValues, filters: IssueListFilters): void {
  if (outputFormat(values) === "md") {
    process.stdout.write(renderMarkdownForTerminal(issueListResponseToMarkdown(response, filters)));
    return;
  }

  console.log(JSON.stringify(values.raw === true ? response : summarizeIssueListResponse(response), null, 2));
}

async function redmineGetJsonOptional(config: RedmineConfig, path: string, query?: Record<string, string | number | boolean | undefined>, cacheTtlMs?: number): Promise<{ data?: unknown; warning?: string }> {
  try {
    return { data: cacheTtlMs === undefined ? await redmineGetJson(config, { path, query }) : await redmineGetJsonCached(config, { path, query }, cacheTtlMs) };
  } catch (error) {
    return { warning: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function customFieldsByName(issue: Record<string, unknown>): Record<string, unknown> | undefined {
  const customFields = issue.custom_fields;
  if (!Array.isArray(customFields)) {
    return undefined;
  }

  const byName: Record<string, unknown> = {};
  for (const field of customFields) {
    if (!isRecord(field) || typeof field.name !== "string") {
      continue;
    }
    byName[field.name] = field.value;
  }

  return byName;
}

function detailLabel(name: string, lookups: LookupMaps): string | undefined {
  if (lookups.customFields.has(name.replace(/^cf_/, ""))) {
    return lookups.customFields.get(name.replace(/^cf_/, ""));
  }

  const labels: Record<string, string> = {
    assigned_to_id: "Assignee",
    category_id: "Category",
    done_ratio: "Done ratio",
    due_date: "Due date",
    estimated_hours: "Estimated hours",
    fixed_version_id: "Target version",
    is_private: "Private",
    priority_id: "Priority",
    project_id: "Project",
    start_date: "Start date",
    status_id: "Status",
    subject: "Subject",
    tracker_id: "Tracker",
  };
  return labels[name];
}

function valueLabel(name: string, value: unknown, lookups: LookupMaps): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const key = String(value);
  if (name === "status_id") return lookups.statuses.get(key);
  if (name === "tracker_id") return lookups.trackers.get(key);
  if (name === "priority_id") return lookups.priorities.get(key);
  if (name === "fixed_version_id") return lookups.versions.get(key);
  if (name === "category_id") return lookups.categories.get(key);
  if (name === "assigned_to_id" || name === "user_id" || name === "author_id") return lookups.users.get(key);
  if (name.startsWith("cf_")) return lookups.customFields.get(name.slice(3));
  return undefined;
}

function enrichJournalDetail(detail: unknown, lookups: LookupMaps): unknown {
  if (!isRecord(detail) || typeof detail.name !== "string") {
    return detail;
  }

  const label = detailLabel(detail.name, lookups);
  const oldLabel = valueLabel(detail.name, detail.old_value, lookups);
  const newLabel = valueLabel(detail.name, detail.new_value, lookups);
  return {
    ...detail,
    ...(label ? { label } : {}),
    ...(oldLabel ? { old_label: oldLabel } : {}),
    ...(newLabel ? { new_label: newLabel } : {}),
  };
}

function enrichIssueResponse(response: unknown, enrichment: EnrichmentData): unknown {
  if (!isRecord(response) || !isRecord(response.issue)) {
    return response;
  }

  const issue = response.issue;
  const customFields = customFieldsByName(issue);
  const journals = Array.isArray(issue.journals)
    ? issue.journals.map((journal) => {
        if (!isRecord(journal)) {
          return journal;
        }
        return {
          ...journal,
          details: Array.isArray(journal.details) ? journal.details.map((detail) => enrichJournalDetail(detail, enrichment.lookups)) : journal.details,
        };
      })
    : issue.journals;

  return {
    ...response,
    issue: {
      ...issue,
      ...(customFields ? { custom_fields_by_name: customFields } : {}),
      ...(journals ? { journals } : {}),
      ...(enrichment.timeEntries ? { time_entries: enrichment.timeEntries } : {}),
      _enrichment: {
        includes: DEFAULT_ISSUE_GET_INCLUDE.split(","),
        secondary_resources: ["time_entries", "issue_statuses", "trackers", "issue_priorities", "custom_fields", "versions", "issue_categories", "users"],
        warnings: enrichment.warnings,
      },
    },
  };
}

function collectJournalUserIds(issue: unknown): string[] {
  if (!isRecord(issue) || !Array.isArray(issue.journals)) {
    return [];
  }

  const ids = new Set<string>();
  for (const journal of issue.journals) {
    if (!isRecord(journal)) {
      continue;
    }
    const userId = namedReferenceId(journal.user);
    if (userId) ids.add(userId);
    if (!Array.isArray(journal.details)) {
      continue;
    }
    for (const detail of journal.details) {
      if (!isRecord(detail) || typeof detail.name !== "string") {
        continue;
      }
      if (detail.name === "assigned_to_id" || detail.name === "user_id" || detail.name === "author_id") {
        for (const value of [detail.old_value, detail.new_value]) {
          if (typeof value === "string" || typeof value === "number") {
            ids.add(String(value));
          }
        }
      }
    }
  }
  return [...ids];
}

async function fetchIssueEnrichment(config: RedmineConfig, issueId: number, issue: unknown): Promise<EnrichmentData> {
  const lookups = createLookupMaps();
  const warnings: string[] = [];
  if (isRecord(issue)) {
    addNamedReferencesToMap(lookups.users, [issue.author, issue.assigned_to]);
  }

  const projectId = isRecord(issue) ? namedReferenceId(issue.project) : undefined;
  const requests = await Promise.all([
    redmineGetJsonOptional(config, "/time_entries.json", { issue_id: issueId, limit: 100 }),
    redmineGetJsonOptional(config, "/issue_statuses.json", undefined, DAY_MS),
    redmineGetJsonOptional(config, "/trackers.json", undefined, DAY_MS),
    redmineGetJsonOptional(config, "/enumerations/issue_priorities.json", undefined, DAY_MS),
    redmineGetJsonOptional(config, "/custom_fields.json", undefined, DAY_MS),
    projectId ? redmineGetJsonOptional(config, `/projects/${projectId}/versions.json`, undefined, DAY_MS) : Promise.resolve({ data: undefined, warning: undefined }),
    projectId ? redmineGetJsonOptional(config, `/projects/${projectId}/issue_categories.json`, undefined, DAY_MS) : Promise.resolve({ data: undefined, warning: undefined }),
  ]);

  for (const request of requests) {
    if (request.warning) warnings.push(request.warning);
  }

  const [timeEntries, statuses, trackers, priorities, customFields, versions, categories] = requests.map((request) => request.data);
  addNamedReferencesToMap(lookups.statuses, lookupArray(statuses, "issue_statuses"));
  addNamedReferencesToMap(lookups.trackers, lookupArray(trackers, "trackers"));
  addNamedReferencesToMap(lookups.priorities, lookupArray(priorities, "issue_priorities"));
  addNamedReferencesToMap(lookups.customFields, lookupArray(customFields, "custom_fields"));
  addNamedReferencesToMap(lookups.versions, lookupArray(versions, "versions"));
  addNamedReferencesToMap(lookups.categories, lookupArray(categories, "issue_categories"));

  const userIds = collectJournalUserIds(issue).filter((id) => !lookups.users.has(id)).slice(0, 25);
  const userRequests = await Promise.all(userIds.map((id) => redmineGetJsonOptional(config, `/users/${id}.json`, undefined, DAY_MS)));
  const userLookups = createLookupMaps();
  for (const userRequest of userRequests) {
    if (userRequest.warning) {
      warnings.push(userRequest.warning);
      continue;
    }
    if (isRecord(userRequest.data) && isRecord(userRequest.data.user)) {
      const id = namedReferenceId(userRequest.data.user);
      const name = namedReferenceName(userRequest.data.user);
      if (id && name) {
        userLookups.users.set(id, name);
      }
    }
  }
  mergeLookupMaps(lookups, userLookups);

  return {
    lookups,
    timeEntries: Array.isArray(lookupArray(timeEntries, "time_entries")) ? (lookupArray(timeEntries, "time_entries") as unknown[]) : undefined,
    warnings,
  };
}

async function confirmAll(totalRequests: number): Promise<boolean> {
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`Fetch all? ${totalRequests} requests. Continue? [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    readline.close();
  }
}

function utcDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function formatSprintDate(value: Date, includeYear: boolean): string {
  const day = String(value.getUTCDate()).padStart(2, "0");
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  if (!includeYear) {
    return `${day}.${month}.`;
  }

  const year = String(value.getUTCFullYear()).slice(-2);
  return `${day}.${month}.${year}`;
}

function currentSprintIndex(): number {
  const anchor = new Date(`${SPRINT_ANCHOR_START}T00:00:00Z`);
  const today = utcDateOnly(new Date());
  return Math.floor((today.getTime() - anchor.getTime()) / (SPRINT_DAYS * DAY_MS));
}

function currentSprintNumber(): number {
  return SPRINT_ANCHOR_NUMBER + currentSprintIndex();
}

function sprintLabel(offset: number): string {
  const anchor = new Date(`${SPRINT_ANCHOR_START}T00:00:00Z`);
  const sprintIndex = currentSprintIndex() + offset;
  const sprintNumber = SPRINT_ANCHOR_NUMBER + sprintIndex;
  const start = addDays(anchor, sprintIndex * SPRINT_DAYS);
  const end = addDays(start, SPRINT_WORK_DAYS - 1);
  return `Sprint ${String(sprintNumber).padStart(2, "0")} (${formatSprintDate(start, false)} - ${formatSprintDate(end, true)})`;
}

function resolveSprint(value: string | undefined): SprintFilter | undefined {
  if (!value) {
    return undefined;
  }

  switch (value.toLowerCase()) {
    case "backlog":
      return { kind: "exact", value: "Backlog" };
    case "current":
      return { kind: "exact", value: sprintLabel(0) };
    case "last":
      return { kind: "exact", value: sprintLabel(-1) };
    case "next":
      return { kind: "exact", value: sprintLabel(1) };
    case "past":
      return { kind: "past" };
    case "future":
      return { kind: "future" };
    default:
      return { kind: "exact", value };
  }
}

function resolveStatus(value: string | undefined): string {
  if (!value || value === "open") {
    return "open";
  }
  if (value === "all") {
    return "*";
  }
  return value;
}

function buildIssueQuery(filters: IssueListFilters, limit: number, offset: number): Record<string, string | number | boolean | undefined> {
  return {
    project_id: filters.project,
    assigned_to_id: filters.assignee,
    status_id: filters.status,
    [`cf_${SPRINT_CUSTOM_FIELD_ID}`]: filters.sprint?.kind === "exact" ? filters.sprint.value : undefined,
    sort: "updated_on:desc",
    limit,
    offset,
  };
}

function filtersFromValues(values: ParsedValues, overrides: Partial<IssueListFilters> = {}): IssueListFilters {
  return {
    project: optionalString(values.project),
    assignee: overrides.assignee ?? optionalString(values.assignee),
    status: overrides.status ?? resolveStatus(optionalString(values.status)),
    sprint: overrides.sprint ?? resolveSprint(optionalString(values.sprint)),
  };
}

function getIssueSprintValue(issue: unknown): string | undefined {
  if (!issue || typeof issue !== "object") {
    return undefined;
  }

  const customFields = (issue as { custom_fields?: unknown }).custom_fields;
  if (!Array.isArray(customFields)) {
    return undefined;
  }

  const sprintField = customFields.find((field) => {
    return Boolean(field && typeof field === "object" && (field as { id?: unknown }).id === SPRINT_CUSTOM_FIELD_ID);
  });

  return sprintField && typeof sprintField === "object" && typeof (sprintField as { value?: unknown }).value === "string"
    ? (sprintField as { value: string }).value
    : undefined;
}

function sprintNumberFromValue(value: string | undefined): number | undefined {
  const match = value?.match(/^Sprint\s+(\d+)\b/);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function issueMatchesRelativeSprint(issue: unknown, sprint: SprintFilter): boolean {
  const sprintNumber = sprintNumberFromValue(getIssueSprintValue(issue));
  if (sprintNumber === undefined) {
    return false;
  }

  const current = currentSprintNumber();
  return sprint.kind === "past" ? sprintNumber < current : sprintNumber > current;
}

async function fetchRemainingPages(config: Awaited<ReturnType<typeof loadConfig>>, firstPage: IssueListResponse, filters: IssueListFilters, pageLimit: number, confirm: boolean): Promise<unknown[] | undefined> {
  const totalPages = Math.ceil(firstPage.total_count / pageLimit);
  if (confirm && totalPages > 10 && !(await confirmAll(totalPages))) {
    return undefined;
  }

  const issues = [...firstPage.issues];
  for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
    const page = await redmineGetJson(config, {
      path: "/issues.json",
      query: buildIssueQuery(filters, pageLimit, pageIndex * pageLimit),
    });

    if (!isIssueListResponse(page)) {
      throw new Error("Unexpected Redmine issue list response");
    }
    issues.push(...page.issues);
  }

  return issues;
}

async function executeIssueList(values: ParsedValues, filters: IssueListFilters): Promise<void> {
  const limit = optionalNumber(values.limit, 25);
  if (limit < 1) {
    throw new Error("Expected --limit to be at least 1");
  }
  const offset = optionalNumber(values.offset, 0);
  const config = await loadConfig();

  if (filters.sprint?.kind === "past" || filters.sprint?.kind === "future") {
    const pageLimit = 100;
    const serverFilters = { ...filters, sprint: undefined };
    const firstPage = await redmineGetJson(config, {
      path: "/issues.json",
      query: buildIssueQuery(serverFilters, pageLimit, 0),
    });

    if (!isIssueListResponse(firstPage)) {
      throw new Error("Unexpected Redmine issue list response");
    }

    const allIssues = await fetchRemainingPages(config, firstPage, serverFilters, pageLimit, values.yes !== true);
    if (!allIssues) {
      return;
    }

    const filteredIssues = allIssues.filter((issue) => issueMatchesRelativeSprint(issue, filters.sprint as SprintFilter));
    const issues = values.all === true ? filteredIssues.slice(offset) : filteredIssues.slice(offset, offset + limit);
    const response = { ...firstPage, issues, total_count: filteredIssues.length, offset, limit: values.all === true ? issues.length : limit };
    printIssueListResponse(response, values, filters);
    return;
  }

  const firstPage = await redmineGetJson(config, {
    path: "/issues.json",
    query: buildIssueQuery(filters, limit, offset),
  });

  if (values.all !== true) {
    if (!isIssueListResponse(firstPage)) {
      throw new Error("Unexpected Redmine issue list response");
    }
    printIssueListResponse(firstPage, values, filters);
    return;
  }

  if (!isIssueListResponse(firstPage)) {
    throw new Error("Unexpected Redmine issue list response");
  }

  const totalRemaining = Math.max(firstPage.total_count - offset, 0);
  const totalPages = Math.ceil(totalRemaining / limit);
  if (totalPages > 10 && values.yes !== true && !(await confirmAll(totalPages))) {
    return;
  }

  const issues = [...firstPage.issues];
  for (let pageIndex = 1; pageIndex < totalPages; pageIndex += 1) {
    const pageOffset = offset + pageIndex * limit;
    const page = await redmineGetJson(config, {
      path: "/issues.json",
      query: buildIssueQuery(filters, limit, pageOffset),
    });

    if (!isIssueListResponse(page)) {
      throw new Error("Unexpected Redmine issue list response");
    }
    issues.push(...page.issues);
  }

  const response = { ...firstPage, issues, offset, limit: issues.length };
  printIssueListResponse(response, values, filters);
}

const issueListFlags = [
  {
    name: "project",
    aliases: ["p"],
    type: "string" as const,
    description: "Project identifier or ID to filter by",
  },
  {
    name: "assignee",
    type: "string" as const,
    description: "Assignee user ID, or 'me'",
  },
  {
    name: "status",
    type: "string" as const,
    description: "Issue status filter: open, closed, all, or a status ID",
    defaultValue: "open",
  },
  {
    name: "sprint",
    type: "string" as const,
    description: "Sprint filter: backlog, current, last, next, past, future, or an exact Sprint custom-field value",
  },
  {
    name: "limit",
    type: "string" as const,
    description: "Maximum number of issues to return",
    defaultValue: "25",
  },
  {
    name: "offset",
    type: "string" as const,
    description: "Number of issues to skip",
    defaultValue: "0",
  },
  {
    name: "all",
    aliases: ["a"],
    type: "boolean" as const,
    description: "Fetch all pages",
  },
  {
    name: "raw",
    type: "boolean" as const,
    description: "Output unmodified Redmine issue list JSON",
  },
  {
    name: "output",
    aliases: ["o"],
    type: "string" as const,
    choices: ["json", "md"],
    description: "Output format: json or md",
    defaultValue: "json",
  },
  {
    name: "yes",
    aliases: ["y"],
    type: "boolean" as const,
    description: "Skip confirmation prompts",
  },
];

export const issueGetCommand: CommandDefinition = {
  name: "get",
  requiresConfig: true,
  aliases: ["show"],
  summary: "Get an issue",
  description: "Get a single Redmine issue as JSON. Journals, attachments, relations, changesets, and watchers are included by default.",
  arguments: [
    {
      name: "id",
      description: "Issue ID",
      required: true,
    },
  ],
  flags: [
    {
      name: "include",
      aliases: ["i"],
      type: "string" as const,
      description: "Comma-separated Redmine issue includes, or 'none'",
      defaultValue: DEFAULT_ISSUE_GET_INCLUDE,
    },
    {
      name: "raw",
      type: "boolean" as const,
      description: "Output only the primary Redmine issue response, without secondary detail enrichment",
    },
    {
      name: "output",
      aliases: ["o"],
      type: "string" as const,
      choices: ["json", "md"],
      description: "Output format: json or md",
      defaultValue: "json",
    },
    {
      name: "no-secondary",
      type: "boolean" as const,
      description: "Skip secondary requests for time entries and lookup metadata",
    },
  ],
  examples: ["redmine issue get 43135", "redmine issue get 43135 -o md", "redmine issue get 43135 --include journals,attachments,relations", "redmine issue get 43135 --include none", "redmine issue get 43135 --raw"],
  execute: async ({ values, positionals }) => {
    if (positionals.length !== 1) {
      throw new Error("Expected exactly one issue ID argument");
    }

    const issueId = requirePositiveInteger(positionals[0], "issue ID");
    const include = optionalString(values.include);
    const config = await loadConfig();
    const response = await redmineGetJson(config, {
      path: `/issues/${issueId}.json`,
      query: { include: include && include !== "none" ? include : undefined },
    });

    const format = outputFormat(values);
    if (values.raw === true || values["no-secondary"] === true || !isRecord(response) || !isRecord(response.issue)) {
      if (format === "md") {
        process.stdout.write(renderMarkdownForTerminal(issueResponseToMarkdown(response)));
        return;
      }
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    const enrichment = await fetchIssueEnrichment(config, issueId, response.issue);
    const enriched = enrichIssueResponse(response, enrichment);
    if (format === "md") {
      process.stdout.write(renderMarkdownForTerminal(issueResponseToMarkdown(enriched)));
      return;
    }
    console.log(JSON.stringify(enriched, null, 2));
  },
};

export const issueListCommand: CommandDefinition = {
  name: "list",
  requiresConfig: true,
  summary: "List issues",
  description: "List Redmine issues. Results are filtered to semantically open issues by default.",
  flags: issueListFlags,
  examples: [
    "redmine issue list",
    "redmine issue list -p ai",
    "redmine issue list -p ai -o md",
    "redmine issue list --assignee me --sprint current",
    "redmine issue list --assignee 585 --status all",
    "redmine issue list --sprint backlog -a -y",
    "redmine issue list --assignee me --sprint past",
  ],
  execute: async ({ values, positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }

    await executeIssueList(values, filtersFromValues(values));
  },
};

export const issueMineCommand: CommandDefinition = {
  name: "mine",
  requiresConfig: true,
  summary: "List my open issues",
  description: "List issues assigned to the configured Redmine user. Results are filtered to semantically open issues by default.",
  flags: issueListFlags.filter((flag) => flag.name !== "assignee"),
  examples: ["redmine issue mine", "redmine issue mine --sprint current", "redmine issue mine -p ai --sprint backlog"],
  execute: async ({ values, positionals }) => {
    if (positionals.length > 0) {
      throw new Error(`Unexpected argument: ${positionals[0]}`);
    }

    await executeIssueList(values, filtersFromValues(values, { assignee: "me" }));
  },
};

export const issueAssignedCommand: CommandDefinition = {
  name: "assigned",
  requiresConfig: true,
  summary: "List issues assigned to a user",
  description: "List issues assigned to a Redmine user ID, or to 'me'. Results are filtered to semantically open issues by default.",
  arguments: [
    {
      name: "assignee",
      description: "Assignee user ID, or 'me'",
      required: true,
    },
  ],
  flags: issueListFlags.filter((flag) => flag.name !== "assignee"),
  examples: ["redmine issue assigned me", "redmine issue assigned 585 --sprint current", "redmine issue assigned 585 -p ai"],
  execute: async ({ values, positionals }) => {
    if (positionals.length !== 1) {
      throw new Error("Expected exactly one assignee argument: user ID or 'me'");
    }

    await executeIssueList(values, filtersFromValues(values, { assignee: positionals[0] }));
  },
};

export const issueCommand: CommandDefinition = {
  name: "issue",
  aliases: ["issues"],
  summary: "Work with issues",
  description: "Commands for Redmine issues.",
  subcommands: [issueGetCommand, issueListCommand, issueMineCommand, issueAssignedCommand],
};
