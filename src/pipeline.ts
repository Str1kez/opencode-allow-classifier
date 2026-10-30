import {
  classify,
  normalizeTask,
  SAFETY_THRESHOLD,
  type AskModel,
  type ClassificationRequest,
  type ClassifierFailureKind,
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
  readonly threshold?: number;
  readonly realpath?: RealPathResolver;
}

export interface EvaluationInput {
  readonly resources: ReadonlyArray<string>;
  readonly cwd: string;
  readonly agent?: string;
  readonly task?: string | null;
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
 * Auto-mode pipeline: hard-ask → allowlist with guard → cache → model → default `ask`.
 *
 * `decide` owns the static stages and never sees an Effect. Only a call that falls through the
 * allowlist reaches the cache and the model. Hard-ask and a fired guard stay `ask` with their own
 * source, exactly as before. The classifier can only lower `ask` to `allow`; nothing here can deny.
 */
export async function evaluate(input: EvaluationInput, options: PipelineOptions): Promise<Decision> {
  const started = performance.now();
  const staticDecision = decide(input.resources, input.cwd, options.realpath);

  if (staticDecision.source !== "default" || staticDecision.rule === "empty-resources") {
    return staticDecision;
  }

  const ask = options.ask;
  if (ask === undefined) return staticDecision;

  const task = normalizeTask(input.task);
  const request: ClassificationRequest = {
    commands: input.resources,
    cwd: input.cwd,
    agent: input.agent ?? null,
    task,
  };
  const threshold = options.threshold ?? SAFETY_THRESHOLD;

  try {
    const outcome = await options.cache.getOrCompute(
      verdictCacheKey(input.cwd, input.resources),
      async () => {
        const result = await classify(ask, request);
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
