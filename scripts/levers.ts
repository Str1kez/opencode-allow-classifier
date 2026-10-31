/**
 * Lever layer on top of the ask-cluster report.
 *
 * Every cluster is assigned to exactly one lever and, when the evidence is strong enough, gets one
 * recommendation. The layer is advisory only: it never edits the policy, never proposes a deny change
 * and never turns a classifier failure into allowlist advice. Everything is pure, so repeated runs on
 * the same clusters produce the same bytes.
 */
import { SAFETY_THRESHOLD } from "../src/classifier.ts";
import { programOf, tokenize } from "../src/shell.ts";
import type { ClusterReport } from "./report.ts";

export const LEVERS = ["allowlist-and-guards", "model-and-threshold", "hard-ask", "classifier-errors"] as const;
export type Lever = (typeof LEVERS)[number];

export type RecommendationKind = "allowlist-expansion" | "hard-ask-exception" | "threshold-lowering";

/** Three independent occurrences make a policy pattern; one or two are noise. */
export const EVIDENCE_THRESHOLD = 3;

export interface LeverCluster {
  readonly signature: string;
  readonly occurrences: number;
  readonly example: string;
  readonly note: string;
}

export interface LeverSection {
  readonly lever: Lever;
  readonly clusters: readonly LeverCluster[];
}

export interface Recommendation {
  readonly kind: RecommendationKind;
  readonly lever: Lever;
  readonly signature: string;
  readonly occurrences: number;
  readonly example: string;
  /** Command shapes that start passing without a prompt if the recommendation is applied. */
  readonly newAllows: readonly string[];
  readonly risk: string;
  readonly why: string;
}

export interface Observation {
  readonly signature: string;
  readonly lever: Lever;
  readonly occurrences: number;
  readonly note: string;
}

export interface ClassifierErrorReport {
  readonly signature: string;
  readonly occurrences: number;
  readonly rule: string;
  readonly example: string;
  readonly recommendation: string;
}

export interface LeverReport {
  readonly levers: readonly LeverSection[];
  readonly recommendations: readonly Recommendation[];
  readonly observations: readonly Observation[];
  readonly classifierErrors: readonly ClassifierErrorReport[];
}

/**
 * A guard that protects secrets, writes, system paths, execution or the cwd boundary is not a tuning
 * candidate: the ask is the point. The report says "keep" and never suggests widening it.
 */
const SAFETY_GUARDS: ReadonlySet<string> = new Set([
  "outside-cwd",
  "untrusted-binary",
  "system-etc",
  "system-proc",
  "endless-read",
  "stdin-read",
  "jq-environment",
  "redirect",
  "tee",
  "output-short-flag",
  "output-long-flag",
  "rg-preprocessor",
  "git-external-command",
  "file-read-flag",
  "jq-program-file",
  "set-clock",
  "tail-follow",
  "file-compile",
  "shell-operator",
  "shell-substitution",
  "shell-backtick",
  "rg-unrestricted",
  "recursive-search",
  "find-write",
  "find-exec",
]);

/**
 * The one guard that is a false-positive candidate: it is deliberately noisy about quoted
 * metacharacters. Every other guard maps to a real write, a secret or an execution path.
 */
const FALSE_POSITIVE_GUARDS: ReadonlySet<string> = new Set(["shell-metacharacter"]);

/**
 * Shapes the analyzer is willing to call read-only without a matching allowlist rule. Deliberately
 * narrow and scoped to a program plus subcommand: a program name alone is not evidence (`gh` can
 * create issues, `docker` can run containers). Everything not listed here stays an observation.
 */
const READ_ONLY_SHAPES: readonly (readonly string[])[] = [
  ["gh", "issue", "view"],
  ["gh", "issue", "list"],
  ["gh", "pr", "view"],
  ["gh", "pr", "list"],
  ["gh", "pr", "diff"],
  ["gh", "pr", "checks"],
  ["gh", "run", "view"],
  ["gh", "run", "list"],
  ["gh", "repo", "view"],
  ["gh", "release", "view"],
  ["gh", "release", "list"],
  ["docker", "ps"],
  ["docker", "images"],
  ["docker", "logs"],
  ["docker", "inspect"],
  ["docker", "version"],
  ["docker", "info"],
  ["kubectl", "get"],
  ["kubectl", "describe"],
  ["kubectl", "logs"],
  ["kubectl", "version"],
  ["git", "ls-files"],
  ["git", "describe"],
  ["git", "for-each-ref"],
  ["ps"],
  ["tree"],
  ["lsof"],
  ["fd"],
];

/** The hard-ask categories that must never be weakened, even by a narrow exception. */
const FORBIDDEN_HARD_ASK: ReadonlySet<string> = new Set([
  "sudo",
  "git-push",
  "rm-outside-cwd",
  "npm-install",
  "pip-install",
  "uv-install",
  "cargo-install",
  "brew-install",
  "alembic-migration",
  "prisma-migration",
  "goose-migration",
  "flyway-migration",
]);

const RECOMMENDATION_RANK: Readonly<Record<RecommendationKind, number>> = {
  "allowlist-expansion": 0,
  "hard-ask-exception": 1,
  "threshold-lowering": 2,
};

/**
 * Mixed clusters pick one lever by this order: an operational error first (never read as policy
 * evidence), then a deterministic hard-ask (it stays even if the allowlist or threshold changes),
 * then the allowlist/guard path, then the model/threshold path. Documented in SKILL.md.
 */
export function leverOf(cluster: ClusterReport): Lever {
  const sources = cluster.sources;
  if (count(sources, "error") > 0 || hasUnknownSource(sources)) return "classifier-errors";
  if (count(sources, "hard-ask") > 0) return "hard-ask";
  if (count(sources, "allowlist") > 0 || count(sources, "default") > 0) return "allowlist-and-guards";
  if (count(sources, "model") > 0 || count(sources, "cache") > 0) return "model-and-threshold";
  return "classifier-errors";
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set(["allowlist", "default", "model", "cache", "hard-ask", "error"]);

function hasUnknownSource(sources: Readonly<Record<string, number>>): boolean {
  return Object.keys(sources).some((source) => !KNOWN_SOURCES.has(source));
}

function count(sources: Readonly<Record<string, number>>, name: string): number {
  return sources[name] ?? 0;
}

export function buildLeverReport(clusters: readonly ClusterReport[], threshold: number = SAFETY_THRESHOLD): LeverReport {
  const sections: { lever: Lever; clusters: LeverCluster[] }[] = LEVERS.map((lever) => ({
    lever,
    clusters: [],
  }));
  const recommendations: Recommendation[] = [];
  const observations: Observation[] = [];
  const classifierErrors: ClassifierErrorReport[] = [];

  for (const cluster of clusters) {
    const lever = leverOf(cluster);
    const note = noteFor(cluster, lever, threshold);
    sectionOf(sections, lever).clusters.push({
      signature: cluster.signature,
      occurrences: cluster.occurrences,
      example: cluster.example,
      note,
    });

    if (lever === "classifier-errors") {
      classifierErrors.push({
        signature: cluster.signature,
        occurrences: cluster.occurrences,
        rule: Object.keys(cluster.rules).sort(compareText).join(",") || "-",
        example: cluster.example,
        recommendation: "Починить ошибку классификатора: провайдер, модель или таймаут; политику разрешений не менять.",
      });
      continue;
    }

    const recommendation = recommendationFor(cluster, lever, threshold);
    if (recommendation === undefined) {
      observations.push({
        signature: cluster.signature,
        lever,
        occurrences: cluster.occurrences,
        note,
      });
    } else {
      recommendations.push(recommendation);
    }
  }

  for (const section of sections) {
    section.clusters.sort(
      (left, right) => right.occurrences - left.occurrences || compareText(left.signature, right.signature),
    );
  }
  recommendations.sort(compareRecommendations);
  observations.sort((left, right) => right.occurrences - left.occurrences || compareText(left.signature, right.signature));
  classifierErrors.sort(
    (left, right) => right.occurrences - left.occurrences || compareText(left.signature, right.signature),
  );

  return { levers: sections, recommendations, observations, classifierErrors };
}

/** Safety order first, then evidence, then a stable name. Exported for the ordering test. */
export function compareRecommendations(left: Recommendation, right: Recommendation): number {
  return (
    RECOMMENDATION_RANK[left.kind] - RECOMMENDATION_RANK[right.kind] ||
    right.occurrences - left.occurrences ||
    compareText(left.signature, right.signature)
  );
}

function sectionOf(
  sections: readonly { lever: Lever; clusters: LeverCluster[] }[],
  lever: Lever,
): { clusters: LeverCluster[] } {
  const section = sections.find((candidate) => candidate.lever === lever);
  if (section === undefined) throw new Error(`missing lever section: ${lever}`);
  return section;
}

function recommendationFor(
  cluster: ClusterReport,
  lever: Lever,
  threshold: number,
): Recommendation | undefined {
  if (cluster.occurrences < EVIDENCE_THRESHOLD) return undefined;

  switch (lever) {
    case "allowlist-and-guards":
      return allowlistRecommendation(cluster);
    case "hard-ask":
      return hardAskRecommendation(cluster);
    case "model-and-threshold":
      return thresholdRecommendation(cluster, threshold);
    case "classifier-errors":
      return undefined;
  }
}

function allowlistRecommendation(cluster: ClusterReport): Recommendation | undefined {
  const guards = guardNames(cluster);
  if (guards.some(isDenyLikeGuard)) return undefined;

  const hasAllowlist = count(cluster.sources, "allowlist") > 0;
  const hasDefault = count(cluster.sources, "default") > 0;

  // A guard false-positive on a command that already matches a read-only rule.
  if (hasAllowlist && guards.length > 0) {
    if (!guards.every((guard) => FALSE_POSITIVE_GUARDS.has(guard))) return undefined;
    return {
      kind: "allowlist-expansion",
      lever: "allowlist-and-guards",
      signature: cluster.signature,
      occurrences: cluster.occurrences,
      example: cluster.example,
      newAllows: [cluster.signature],
      risk:
        "Риск: расширение гарда на этот shape пропустит активный метасимвол, если кавычки в команде не литеральные.",
      why: `Команда уже входит в read-only allowlist; ask вызывает только гард ${guards.join(",")}. Правка должна быть узкой: только этот shape.`,
    };
  }

  // A read-only shape with no matching allowlist rule.
  if (hasDefault && guards.length === 0 && isReadOnlyShape(cluster.example)) {
    return {
      kind: "allowlist-expansion",
      lever: "allowlist-and-guards",
      signature: cluster.signature,
      occurrences: cluster.occurrences,
      example: cluster.example,
      newAllows: [cluster.signature],
      risk:
        `Риск: если форма окажется не read-only, новое правило станет обходом записи; добавляй узкий префикс "${cluster.signature}", а не программу целиком.`,
      why: "Форма входит в консервативный список read-only команд, но правила для неё нет. Расширение allowlist безопаснее правки порога.",
    };
  }

  return undefined;
}

function hardAskRecommendation(cluster: ClusterReport): Recommendation | undefined {
  const rules = clusterRules(cluster);
  if (rules.length === 0) return undefined;
  // A hard-ask on a mutating command is legitimate: keep it. Only a read-only shape can be a
  // narrow false positive, and only when the rule is outside the forbidden categories.
  if (rules.some(isForbiddenHardAsk)) return undefined;
  if (!isReadOnlyShape(cluster.example)) return undefined;

  return {
    kind: "hard-ask-exception",
    lever: "hard-ask",
    signature: cluster.signature,
    occurrences: cluster.occurrences,
    example: cluster.example,
    newAllows: [cluster.signature],
    risk:
      "Риск: ослабление hard-ask; ошибка в форме превращает обязательный ask в allow. Исключение не должно расширяться на соседние команды.",
    why: `Hard-ask ${rules.join(",")} сработал на read-only форме и не входит в запрещённые категории. Исключение узкое — только этот shape.`,
  };
}

function thresholdRecommendation(cluster: ClusterReport, threshold: number): Recommendation | undefined {
  const probability = cluster.probability;
  if (probability === null) return undefined;
  if (probability.max >= threshold) return undefined;

  return {
    kind: "threshold-lowering",
    lever: "model-and-threshold",
    signature: cluster.signature,
    occurrences: cluster.occurrences,
    example: cluster.example,
    newAllows: [cluster.signature],
    risk:
      "Риск: снижение порога разрешит все формы с вероятностью выше нового значения, а не только этот кластер; ложные allow глобальные.",
    why: `Все вхождения ниже порога ${threshold}: median=${probability.median}, max=${probability.max}. Порог не выше ${probability.max} пропустит все вхождения.`,
  };
}

function noteFor(cluster: ClusterReport, lever: Lever, threshold: number): string {
  if (lever !== "classifier-errors" && cluster.occurrences < EVIDENCE_THRESHOLD) {
    return `ниже порога доказательности: ${cluster.occurrences} < ${EVIDENCE_THRESHOLD} вхождений`;
  }

  switch (lever) {
    case "classifier-errors":
      return `ошибка классификатора (${clusterRules(cluster).join(",") || "-"}): отдельная секция, политику не менять`;
    case "hard-ask": {
      const rules = clusterRules(cluster);
      if (rules.some(isForbiddenHardAsk)) {
        return `hard-ask ${rules.join(",")}: оставить — исключение не рекомендуется`;
      }
      if (isReadOnlyShape(cluster.example)) return `hard-ask ${rules.join(",")} на read-only форме: рекомендация ниже`;
      return `hard-ask ${rules.join(",")}: оставить — исключение не рекомендуется`;
    }
    case "allowlist-and-guards": {
      const guards = guardNames(cluster);
      if (guards.some(isDenyLikeGuard)) {
        return `гард ${guards.join(",")}: оставить, прав разрешения не менять`;
      }
      if (guards.length > 0) {
        const falsePositive = guards.every((guard) => FALSE_POSITIVE_GUARDS.has(guard));
        return falsePositive
          ? `гард ${guards.join(",")} похож на ложное срабатывание: рекомендация ниже`
          : `гард ${guards.join(",")}: оставить, прав разрешения не менять`;
      }
      if (count(cluster.sources, "default") > 0 && isReadOnlyShape(cluster.example)) {
        return "read-only форма без правила allowlist: рекомендация ниже";
      }
      return "нет совпадения с allowlist, read-only не подтверждён — правило не предлагается";
    }
    case "model-and-threshold": {
      const probability = cluster.probability;
      if (probability === null) return "нет вероятности модели — порог не рычаг";
      if (probability.max >= threshold) {
        return `вероятность не ниже порога ${threshold} — порог не рычаг`;
      }
      return `вероятность ниже порога ${threshold}: рекомендация ниже`;
    }
  }
}

function guardNames(cluster: ClusterReport): string[] {
  const names = new Set<string>();
  for (const rule of Object.keys(cluster.rules)) {
    for (const member of rule.split(",")) {
      const trimmed = member.trim();
      if (trimmed.startsWith("guard:")) names.add(trimmed.slice("guard:".length));
    }
  }
  return [...names].sort(compareText);
}

function clusterRules(cluster: ClusterReport): string[] {
  const names = new Set<string>();
  for (const rule of Object.keys(cluster.rules)) {
    for (const member of rule.split(",")) {
      const trimmed = member.trim();
      if (trimmed.length > 0) names.add(trimmed);
    }
  }
  return [...names].sort(compareText);
}

function isDenyLikeGuard(name: string): boolean {
  return name.startsWith("secret-") || SAFETY_GUARDS.has(name);
}

function isForbiddenHardAsk(rule: string): boolean {
  return FORBIDDEN_HARD_ASK.has(rule) || rule.includes("install") || rule.includes("migration");
}

/** Program plus subcommand match; the raw example is tokenized with the plugin's own tokenizer. */
function isReadOnlyShape(example: string): boolean {
  const tokens = tokenize(example);
  for (const shape of READ_ONLY_SHAPES) {
    if (tokens.length < shape.length) continue;
    if (programOf(tokens[0]) !== shape[0]) continue;
    if (shape.every((token, index) => tokens[index] === token)) return true;
  }
  return false;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
