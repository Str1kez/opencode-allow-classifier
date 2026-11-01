import {
  classify,
  hashSystemContext,
  normalizeSystemContext,
  normalizeTask,
  SAFETY_THRESHOLD,
  type AskModel,
  type ClassificationRequest,
  type ClassifierFailureKind,
  type SystemContextInfo,
} from "./classifier.ts";
import { verdictCacheKey, type VerdictCache } from "./cache.ts";
import { decide, type Decision, type DecisionSource, type Verdict } from "./policy.ts";
import type { RealPathResolver } from "./shell.ts";

/** What the cache stores: a successful model verdict only. Failures are never cached. */
export interface CachedVerdict {
  readonly probability: number;
  readonly model: string;
}

export interface PipelineOptions {
  readonly cache: VerdictCache<CachedVerdict>;
  /** Absent when the host has no generate API; the default `ask` then stands. */
  readonly ask?: AskModel;
  /** Classifier model from the effective settings; the stock default applies when absent. */
  readonly model?: string;
  readonly threshold?: number;
  /** Total classifier budget; the stock 3 s applies when absent. */
  readonly timeoutMs?: number;
  readonly realpath?: RealPathResolver;
  /**
   * Send the last system message to the classifier. Off by default: system text may contain internal
   * data and leaves the machine when the classifier runs on a remote provider.
   */
  readonly includeSystemContext?: boolean;
}

/** One read of the session, so the task and the system context cost a single round-trip. */
export interface SessionSnapshot {
  readonly task: string | null;
  readonly system: string | null;
}

/** The normalized context the classifier actually saw. The audit writes this, it never re-derives it. */
export interface SessionFacts {
  readonly task: string | null;
  readonly system: SystemContextInfo;
}

export interface EvaluationInput {
  readonly resources: ReadonlyArray<string>;
  readonly cwd: string;
  readonly agent?: string;
  /**
   * Read lazily: the session lookup costs a round-trip and may hang, so a hard-ask or an allowlist hit
   * must never pay for it. Only a call that actually reaches the model asks for the session.
   */
  readonly readSession?: () => Promise<SessionSnapshot>;
  /** Called once when the model path runs, with the normalized task and system facts for the audit. */
  readonly onSessionFacts?: (facts: SessionFacts) => void;
}

/** Carries the failing model through the cache, which stores values and rejects errors. */
class ClassifierError extends Error {
  readonly kind: ClassifierFailureKind;
  readonly model: string;

  constructor(kind: ClassifierFailureKind, model: string, message: string) {
    super(message);
    this.name = "ClassifierError";
    this.kind = kind;
    this.model = model;
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

/**
 * Auto-mode pipeline: hard-ask → guard → allowlist → cache → model → default `ask`.
 *
 * `decide` owns the static stages and never sees an Effect. Only a call that falls through the
 * allowlist reaches the cache and the model. Hard-ask and a fired guard stay `ask` with their own
 * source. The classifier can only lower `ask` to `allow`; nothing here can deny.
 */
export async function evaluate(input: EvaluationInput, options: PipelineOptions): Promise<Decision> {
  const started = performance.now();
  const staticDecision = decide(input.resources, input.cwd, options.realpath);

  if (staticDecision.source !== "default" || staticDecision.rule === "empty-resources") {
    return staticDecision;
  }

  const ask = options.ask;
  if (ask === undefined) return staticDecision;

  const threshold = options.threshold ?? SAFETY_THRESHOLD;

  try {
    const session =
      input.readSession === undefined
        ? { task: null, system: null }
        : await input.readSession();
    const task = normalizeTask(session.task);
    const system = options.includeSystemContext === true ? normalizeSystemContext(session.system) : null;
    // The system text is part of the prompt, so a different message must not reuse a verdict scored
    // against the old instructions. Without the option the hash stays null and the key is unchanged.
    const systemContextHash = system === null ? null : hashSystemContext(system);
    input.onSessionFacts?.({
      task,
      system: {
        used: system !== null,
        length: system === null ? null : system.length,
        hash: systemContextHash,
      },
    });
    const request: ClassificationRequest = {
      commands: input.resources,
      cwd: input.cwd,
      agent: input.agent ?? null,
      task,
      system,
    };
    const outcome = await options.cache.getOrCompute(
      verdictCacheKey(input.cwd, input.resources, systemContextHash),
      async () => {
        const result = await classify(ask, request, options.model, options.timeoutMs);
        if (!result.ok) throw new ClassifierError(result.failure.kind, result.model, result.failure.message);
        return { probability: result.probability, model: result.model };
      },
    );

    const verdict: Verdict = outcome.value.probability >= threshold ? "allow" : "ask";
    const source: DecisionSource = outcome.origin === "computed" ? "model" : "cache";
    return {
      verdict,
      source,
      rule: "classifier",
      probability: outcome.value.probability,
      model: outcome.value.model,
      latency: elapsed(started),
    };
  } catch (error) {
    // The stable contract is fail-open toward `ask`: a dead model, a timeout or a bug in the
    // classifier must never turn a shell call into `allow`.
    const failure = error instanceof ClassifierError ? error : undefined;
    return {
      verdict: "ask",
      source: "error",
      rule: failure === undefined ? "classifier:error" : `classifier:${failure.kind}`,
      probability: null,
      model: failure?.model ?? null,
      latency: elapsed(started),
    };
  }
}
