/**
 * Ask-cluster report over the classifier audit log.
 *
 * The report answers one question: which command shapes keep asking the human? Everything here is
 * deterministic — the same log and window produce the same bytes, so two runs can be compared and a
 * policy decision never depends on the mood of the run. The only input that changes is the window
 * start, and it is printed as a date, not as the moment of the run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AuditEntry } from "../src/audit.ts";
import { hasActiveShellSyntax } from "../src/shell.ts";
import {
  buildLeverReport,
  type ClassifierErrorReport,
  type LeverSection,
  type Observation,
  type Recommendation,
} from "./levers.ts";

const MILLISECONDS_PER_DAY = 86_400_000;
const AUDIT_FILE_NAME = /^evaluate-\d{4}-\d{2}\.jsonl$/;
/** Eight or more hex characters with at least one letter: commit hashes, not plain numbers. */
const LONG_HEX_TOKEN = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const EMPTY_SIGNATURE = "<empty>";

/** A bad `--since` is a usage error, not a broken audit. */
export class ReportUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportUsageError";
  }
}

export interface ReportFilters {
  readonly sources: readonly string[];
  readonly rules: readonly string[];
}

/** The parsed window. `days` is `null` when the user passed an exact date. */
export interface AnalysisWindow {
  readonly since: string;
  readonly days: number | null;
  readonly cutoffMs: number;
}

export interface ClusterProbability {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export interface ClusterReport {
  readonly signature: string;
  readonly occurrences: number;
  readonly probability: ClusterProbability | null;
  readonly sources: Readonly<Record<string, number>>;
  readonly rules: Readonly<Record<string, number>>;
  readonly projects: number;
  readonly agents: number;
  readonly example: string;
  /** True when any raw resource in the cluster kept shell syntax after quotes are blanked. */
  readonly activeSyntax: boolean;
}

export interface AskReport {
  readonly auditDir: string;
  readonly configPath: string | null;
  readonly window: { readonly since: string; readonly days: number | null };
  readonly sandboxExcluded: boolean;
  readonly files: readonly string[];
  readonly skippedLines: number;
  readonly filters: ReportFilters;
  readonly totals: { readonly entries: number; readonly clusters: number };
  /** #14 appends lever sections after this array; the header and cluster shape stay stable. */
  readonly clusters: readonly ClusterReport[];
  readonly levers: readonly LeverSection[];
  readonly recommendations: readonly Recommendation[];
  readonly observations: readonly Observation[];
  readonly classifierErrors: readonly ClassifierErrorReport[];
}

export interface CollectOptions {
  readonly auditDir: string;
  readonly configPath: string | null;
  readonly since: string;
  readonly filters: ReportFilters;
  readonly now: Date;
  readonly repoRoot: string;
  readonly includeSandbox: boolean;
  /** Effective safety threshold; the stock default applies when the config does not provide one. */
  readonly threshold?: number;
}

export interface CollectResult {
  readonly report: AskReport;
  readonly warnings: readonly string[];
}

/**
 * `YYYY-MM-DD` starts at UTC midnight, matching the `toISOString()` time in the audit. `<n>d` means
 * the UTC midnight of the day `n` days ago, so the printed `since` date and the cutoff agree and two
 * runs on the same day produce identical bytes.
 */
export function parseSince(raw: string, now: Date = new Date()): AnalysisWindow {
  const days = /^(\d+)d$/.exec(raw);
  if (days !== null) {
    const count = Number(days[1]);
    if (!Number.isSafeInteger(count)) throw new ReportUsageError(`invalid --since value: ${raw}`);

    const todayStart = Math.floor(now.getTime() / MILLISECONDS_PER_DAY) * MILLISECONDS_PER_DAY;
    const cutoff = new Date(todayStart - count * MILLISECONDS_PER_DAY);
    if (Number.isNaN(cutoff.getTime())) throw new ReportUsageError(`invalid --since value: ${raw}`);

    return { since: cutoff.toISOString().slice(0, 10), days: count, cutoffMs: cutoff.getTime() };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const cutoffMs = Date.parse(`${raw}T00:00:00.000Z`);
    // The round-trip rejects dates like 2026-02-31, which `Date.parse` silently rolls over.
    if (!Number.isNaN(cutoffMs) && new Date(cutoffMs).toISOString().slice(0, 10) === raw) {
      return { since: raw, days: null, cutoffMs };
    }
  }

  throw new ReportUsageError(`invalid --since value: ${raw} (expected YYYY-MM-DD or <n>d)`);
}

/**
 * The human-readable command: resources joined, whitespace left as typed, with numbers and hashes
 * untouched. This is what the report shows as the example, so a newline that hides a second command
 * stays visible instead of collapsing into a harmless-looking one-liner. The normalized clustering
 * key is `commandSignature`.
 */
export function rawCommand(resources: readonly string[]): string {
  return resources.join(" ; ").trim();
}

/**
 * Clustering key. Whitespace collapses, numbers become `<n>` and long hex tokens become `<hex>`, so
 * repeated commands with different issue numbers, line counts and commit hashes land in one cluster.
 * Paths and quoted text stay as-is: the ticket only asks for numeric and hex normalization. The
 * collapsed key is safe because the raw `activeSyntax` flag is computed separately, per cluster.
 */
export function commandSignature(resources: readonly string[]): string {
  const command = rawCommand(resources).replace(/\s+/g, " ").trim();
  if (command.length === 0) return EMPTY_SIGNATURE;
  return command.replace(LONG_HEX_TOKEN, "<hex>").replace(/\d+/g, "<n>");
}

/** Rule strings may hold several names (`git-status,git-diff`); a glob matches any one of them. */
export function ruleMatches(rule: string, globs: readonly string[]): boolean {
  const members = rule.split(",").map((member) => member.trim());
  return members.some((member) => globs.some((glob) => globMatches(member, glob)));
}

export function globMatches(value: string, glob: string): boolean {
  const pattern = glob.replace(/[\\^$.|?+()[\]{}]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${pattern}$`).test(value);
}

export function selectAskEntries(
  entries: readonly AuditEntry[],
  window: AnalysisWindow,
  filters: ReportFilters,
): AuditEntry[] {
  return entries.filter(
    (entry) =>
      entry.verdict === "ask" &&
      Date.parse(entry.time) >= window.cutoffMs &&
      (filters.sources.length === 0 || filters.sources.includes(entry.source)) &&
      (filters.rules.length === 0 || ruleMatches(entry.rule, filters.rules)),
  );
}

export function clusterEntries(entries: readonly AuditEntry[]): ClusterReport[] {
  const clusters = new Map<string, MutableCluster>();

  for (const entry of entries) {
    const signature = commandSignature(entry.resources);
    let cluster = clusters.get(signature);
    if (cluster === undefined) {
      cluster = {
        signature,
        occurrences: 0,
        probabilities: [],
        sources: new Map(),
        rules: new Map(),
        projects: new Set(),
        agents: new Set(),
        examples: new Set(),
        activeSyntax: false,
      };
      clusters.set(signature, cluster);
    }

    cluster.occurrences += 1;
    if (typeof entry.probability === "number" && Number.isFinite(entry.probability)) {
      cluster.probabilities.push(entry.probability);
    }
    increment(cluster.sources, entry.source);
    increment(cluster.rules, entry.rule);
    cluster.projects.add(entry.cwd);
    if (entry.agent !== null && entry.agent !== undefined) cluster.agents.add(entry.agent);
    const raw = rawCommand(entry.resources);
    cluster.examples.add(raw);
    // The flag covers every entry, so a mixed cluster stays unsafe even when its displayed example
    // happens to be the clean one.
    cluster.activeSyntax ||= hasActiveShellSyntax(raw);
  }

  return [...clusters.values()]
    .map(finishCluster)
    .sort((left, right) => right.occurrences - left.occurrences || compareText(left.signature, right.signature));
}

interface MutableCluster {
  readonly signature: string;
  occurrences: number;
  readonly probabilities: number[];
  readonly sources: Map<string, number>;
  readonly rules: Map<string, number>;
  readonly projects: Set<string>;
  readonly agents: Set<string>;
  readonly examples: Set<string>;
  activeSyntax: boolean;
}

function finishCluster(cluster: MutableCluster): ClusterReport {
  const probabilities = [...cluster.probabilities].sort((left, right) => left - right);
  const example = [...cluster.examples].sort(compareText)[0] ?? "";

  return {
    signature: cluster.signature,
    occurrences: cluster.occurrences,
    probability: probabilitySummary(probabilities),
    sources: sortedCounts(cluster.sources),
    rules: sortedCounts(cluster.rules),
    projects: cluster.projects.size,
    agents: cluster.agents.size,
    example,
    activeSyntax: cluster.activeSyntax,
  };
}

function probabilitySummary(sorted: readonly number[]): ClusterProbability | null {
  if (sorted.length === 0) return null;

  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;

  return { median: round4(median), min: round4(sorted[0]!), max: round4(sorted[sorted.length - 1]!) };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of [...counts.keys()].sort(compareText)) {
    // defineProperty keeps keys such as `__proto__` as data instead of changing the prototype.
    Object.defineProperty(result, key, {
      value: counts.get(key),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/** Code-unit comparison: `localeCompare` would make the output depend on the machine locale. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * True when `path` is `<repo>/sandbox` or below. Lexical on purpose: the report must not touch the
 * filesystem to decide whether it may read the filesystem.
 */
export function isSandboxPath(path: string, repoRoot: string): boolean {
  const sandbox = resolve(repoRoot, "sandbox");
  const target = resolve(path);
  return target === sandbox || target.startsWith(`${sandbox}${sep}`);
}

export function collectReport(options: CollectOptions): CollectResult {
  const auditDir = resolve(options.auditDir);
  const window = parseSince(options.since, options.now);
  const warnings: string[] = [];
  const sandboxExcluded = !options.includeSandbox && isSandboxPath(auditDir, options.repoRoot);

  let files: string[] = [];
  const entries: AuditEntry[] = [];
  let skippedLines = 0;

  if (sandboxExcluded) {
    warnings.push(`audit directory is inside the sandbox and was skipped: ${auditDir} (pass --include-sandbox to read it)`);
  } else {
    files = listAuditFiles(auditDir, warnings);
    for (const file of files) {
      const path = join(auditDir, file);
      const text = readAuditFile(path, warnings);
      if (text === undefined) continue;

      for (const [index, line] of text.split("\n").entries()) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        const entry = parseAuditLine(trimmed);
        if (entry === null) {
          skippedLines += 1;
          warnings.push(`${path}:${index + 1}: malformed audit line (skipped)`);
          continue;
        }
        entries.push(entry);
      }
    }
  }

  const selected = selectAskEntries(entries, window, options.filters);
  const clusters = clusterEntries(selected);
  const report: AskReport = {
    auditDir,
    configPath: options.configPath,
    window: { since: window.since, days: window.days },
    sandboxExcluded,
    files,
    skippedLines,
    filters: { sources: [...options.filters.sources], rules: [...options.filters.rules] },
    totals: { entries: selected.length, clusters: clusters.length },
    clusters,
    ...buildLeverReport(clusters, options.threshold),
  };

  return { report, warnings };
}

function listAuditFiles(directory: string, warnings: string[]): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      warnings.push(`audit directory not found: ${directory}`);
      return [];
    }
    throw error;
  }

  return names.filter((name) => AUDIT_FILE_NAME.test(name)).sort(compareText);
}

function readAuditFile(path: string, warnings: string[]): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    warnings.push(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parseAuditLine(line: string): AuditEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return auditEntryOf(value);
}

/**
 * Only the fields the report reads are validated; the rest of `AuditEntry` belongs to the writer.
 * Missing `agent`/`probability` are tolerated as `null` so an older audit file still reports.
 */
function auditEntryOf(value: unknown): AuditEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (typeof record["time"] !== "string" || Number.isNaN(Date.parse(record["time"]))) return null;
  if (!Array.isArray(record["resources"]) || !record["resources"].every((item) => typeof item === "string")) {
    return null;
  }
  if (typeof record["cwd"] !== "string") return null;
  if (typeof record["verdict"] !== "string") return null;
  if (typeof record["source"] !== "string") return null;
  if (typeof record["rule"] !== "string") return null;
  if (record["probability"] !== undefined && record["probability"] !== null && typeof record["probability"] !== "number") {
    return null;
  }
  if (record["agent"] !== undefined && record["agent"] !== null && typeof record["agent"] !== "string") return null;

  return record as unknown as AuditEntry;
}

export function formatReportJson(report: AskReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatReportText(report: AskReport): string {
  const lines = [
    `audit: ${report.auditDir}`,
    `config: ${report.configPath ?? "(none)"}`,
    `window: ${
      report.window.days === null ? `since ${report.window.since}` : `last ${report.window.days} days (since ${report.window.since})`
    }`,
    `sandbox: ${report.sandboxExcluded ? "excluded" : "included"}`,
    `files: ${report.files.length}`,
    `entries: ${report.totals.entries}`,
    `skipped lines: ${report.skippedLines}`,
    `filters: sources=${listOrDash(report.filters.sources)} rules=${listOrDash(report.filters.rules)}`,
    `clusters: ${report.totals.clusters}`,
  ];

  for (const cluster of report.clusters) {
    lines.push(
      "",
      `signature: ${cluster.signature}`,
      `occurrences: ${cluster.occurrences}`,
      `probability: ${formatProbability(cluster.probability)}`,
      `sources: ${formatCounts(cluster.sources)}`,
      `rules: ${formatCounts(cluster.rules)}`,
      `projects: ${cluster.projects}`,
      `agents: ${cluster.agents}`,
      `example: ${cluster.example}`,
    );
  }

  for (const lever of ["allowlist-and-guards", "model-and-threshold", "hard-ask"] as const) {
    lines.push("", `lever: ${lever}`);
    const section = report.levers.find((candidate) => candidate.lever === lever);
    if (section === undefined || section.clusters.length === 0) {
      lines.push("  none");
      continue;
    }
    for (const cluster of section.clusters) {
      lines.push(
        `  ${cluster.signature} — occurrences: ${cluster.occurrences}`,
        `    example: ${cluster.example}`,
        `    note: ${cluster.note}`,
      );
    }
  }

  lines.push("", "recommendations:");
  if (report.recommendations.length === 0) lines.push("  none");
  for (const [index, item] of report.recommendations.entries()) {
    lines.push(
      `  ${index + 1}. ${item.kind} — ${item.signature}`,
      `     lever: ${item.lever}`,
      `     occurrences: ${item.occurrences}`,
      `     new allows: ${item.newAllows.join(", ")}`,
      `     risk: ${item.risk}`,
      `     why: ${item.why}`,
    );
  }
  lines.push("deny rules are out of scope: the report never proposes a deny change.");

  lines.push("", "observations:");
  if (report.observations.length === 0) lines.push("  none");
  for (const item of report.observations) {
    lines.push(
      `  - ${item.signature} — lever: ${item.lever}, occurrences: ${item.occurrences}`,
      `    note: ${item.note}`,
    );
  }

  lines.push("", "lever: classifier-errors");
  if (report.classifierErrors.length === 0) lines.push("  none");
  for (const item of report.classifierErrors) {
    lines.push(
      `  ${item.signature} — occurrences: ${item.occurrences}, rule: ${item.rule}`,
      `    example: ${item.example}`,
      `    recommendation: ${item.recommendation}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatProbability(probability: ClusterProbability | null): string {
  if (probability === null) return "none";
  return `median=${probability.median} min=${probability.min} max=${probability.max}`;
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts).map(([name, count]) => `${name}=${count}`);
  return parts.length === 0 ? "-" : parts.join(", ");
}

function listOrDash(values: readonly string[]): string {
  return values.length === 0 ? "-" : values.join(",");
}
