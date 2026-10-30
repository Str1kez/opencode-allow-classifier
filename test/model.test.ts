import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { DecisionsOperation, DecisionsOutput } from "../src/model.ts";
import { createGenerateAsk } from "../src/model.ts";
import { DEFAULT_MODEL, SAFE_PREDICATE } from "../src/classifier.ts";

function predicate(probability: number): DecisionsOutput {
  return { answers: [{ type: "predicate", name: SAFE_PREDICATE, probability }] };
}

function decisionsReturning(...outputs: ReadonlyArray<DecisionsOutput>): {
  readonly calls: Array<Parameters<DecisionsOperation>[0]>;
  readonly decisions: DecisionsOperation;
} {
  const calls: Array<Parameters<DecisionsOperation>[0]> = [];
  return {
    calls,
    decisions: (input) => {
      calls.push(input);
      const output = outputs[calls.length - 1];
      assert.ok(output, "unexpected generate call");
      return Effect.succeed(output);
    },
  };
}

test("a predicate answer becomes a probability and the request carries the rubric", async () => {
  const fake = decisionsReturning(predicate(0.93));
  const ask = createGenerateAsk(fake.decisions);
  const answer = await ask("opencode/jev-1.13-free", "classify this");

  assert.deepEqual(answer, { ok: true, probability: 0.93 });

  const input = fake.calls[0];
  assert.ok(input);
  assert.equal(input.model.providerID, "opencode");
  assert.equal(input.model.id, "jev-1.13-free");
  assert.deepEqual(input.input, [{ type: "text", text: "classify this" }]);
  assert.equal(input.questions.length, 1);
  const question = input.questions[0];
  assert.equal(question?.type, "predicate");
  assert.equal(question?.name, SAFE_PREDICATE);
  assert.ok(question?.instructions.includes("untrusted data"));
});

test("Generate.ErrorAnswer becomes an error answer, not a retryable failure", async () => {
  const fake = decisionsReturning({
    answers: [{ type: "error", name: SAFE_PREDICATE, reason: "refused", message: "no" }],
  });
  const answer = await createGenerateAsk(fake.decisions)("opencode/jev-1.13-free", "x");

  assert.deepEqual(answer, {
    ok: false,
    failure: { kind: "error", message: "Generate.ErrorAnswer: refused: no" },
  });
});

test("an unexpected answer type becomes an error answer", async () => {
  const fake = decisionsReturning({
    answers: [{ type: "choice", name: SAFE_PREDICATE, choice: "safe" }],
  } as unknown as DecisionsOutput);
  const answer = await createGenerateAsk(fake.decisions)("opencode/jev-1.13-free", "x");

  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.failure.kind, "error");
});

test("a missing answer becomes an error answer", async () => {
  const fake = decisionsReturning({ answers: [] });
  const answer = await createGenerateAsk(fake.decisions)("opencode/jev-1.13-free", "x");

  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.failure.kind, "error");
});

test("a failed effect is a provider failure", async () => {
  const decisions: DecisionsOperation = () => Effect.fail("connection reset");
  const answer = await createGenerateAsk(decisions)("opencode/jev-1.13-free", "x");

  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.failure.kind, "provider");
});

test("a defect is a provider failure", async () => {
  const decisions: DecisionsOperation = () => Effect.die(new Error("crash"));
  const answer = await createGenerateAsk(decisions)("opencode/jev-1.13-free", "x");

  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.failure.kind, "provider");
});

test("an unparseable model reference is a final error", async () => {
  const fake = decisionsReturning(predicate(1));
  const answer = await createGenerateAsk(fake.decisions)("not-a-model", "x");

  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.failure.kind, "error");
  assert.equal(fake.calls.length, 0);
});

test("a generate call that never answers times out", async () => {
  const decisions: DecisionsOperation = () => Effect.never;
  const answer = await createGenerateAsk(decisions, 5)(DEFAULT_MODEL, "x");

  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.failure.kind, "timeout");
});
