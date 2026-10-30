import { Model } from "@opencode/plugin/effect";
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin";
import { Effect, Option, Result } from "effect";
import {
  CLASSIFIER_TIMEOUT_MS,
  SAFE_INSTRUCTIONS,
  SAFE_PREDICATE,
  type AskModel,
  type ClassifierFailureKind,
  type ModelAnswer,
} from "./classifier.ts";

/** The exactly-typed `generate.decisions` operation, derived from the plugin context. */
export type DecisionsOperation = PluginContext["experimental"]["generate"]["decisions"];
export type DecisionsOutput = Effect.Success<ReturnType<DecisionsOperation>>;
type DecisionAnswer = DecisionsOutput["answers"][number];

function failure(kind: ClassifierFailureKind, message: string): ModelAnswer {
  return { ok: false, failure: { kind, message } };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `Generate.ErrorAnswer` and a mistyped answer are ordinary results, not rejected effects, and the
 * retry policy must not treat them as a provider outage.
 */
function readAnswer(answer: DecisionAnswer | undefined): ModelAnswer {
  if (answer === undefined) return failure("error", `no "${SAFE_PREDICATE}" answer`);

  switch (answer.type) {
    case "predicate":
      return { ok: true, probability: answer.probability };
    case "error":
      return failure(
        "error",
        `Generate.ErrorAnswer: ${answer.reason}${answer.message === undefined ? "" : `: ${answer.message}`}`,
      );
    default:
      return failure("error", `unexpected "${answer.type}" answer for "${SAFE_PREDICATE}"`);
  }
}

/**
 * Runs the `generate.decisions` effect to completion with a per-attempt timeout. The operation
 * requires no services (`R = never`), so running it from the async pipeline keeps the classifier and
 * cache free of Effect plumbing. The timeout interrupts the source effect; a timeout is final.
 */
export function createGenerateAsk(
  decisions: DecisionsOperation,
  timeoutMs: number = CLASSIFIER_TIMEOUT_MS,
): AskModel {
  return async (model, prompt) => {
    let effect: ReturnType<DecisionsOperation>;
    try {
      effect = decisions({
        model: Model.Ref.parse(model),
        input: [{ type: "text", text: prompt }],
        questions: [{ type: "predicate", name: SAFE_PREDICATE, instructions: SAFE_INSTRUCTIONS }],
      });
    } catch (error) {
      return failure("error", `cannot build the generate request: ${describe(error)}`);
    }

    let outcome: Result.Result<Option.Option<DecisionsOutput>, unknown>;
    try {
      outcome = await Effect.runPromise(Effect.result(Effect.timeoutOption(effect, timeoutMs)));
    } catch (error) {
      // A defect rather than a typed failure: still a failed model call, and the retry may help.
      return failure("provider", `generate call failed: ${describe(error)}`);
    }

    if (Result.isFailure(outcome)) {
      return failure("provider", `generate call failed: ${describe(outcome.failure)}`);
    }
    if (Option.isNone(outcome.success)) {
      return failure("timeout", `no answer within ${timeoutMs} ms`);
    }

    const output = outcome.success.value;
    return readAnswer(output.answers.find((answer) => answer.name === SAFE_PREDICATE));
  };
}
