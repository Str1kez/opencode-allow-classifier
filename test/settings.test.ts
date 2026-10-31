import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODEL, SAFETY_THRESHOLD } from "../src/classifier.ts";
import { readOptions } from "../src/options.ts";
import {
  isModelString,
  isThreshold,
  normalizeModel,
  parseModelOverride,
  resolveSettings,
} from "../src/settings.ts";

const NO_OPTIONS = { model: undefined, threshold: undefined };

test("options beat the stored override, which beats the default", () => {
  assert.deepEqual(resolveSettings({ model: "acme/configured", threshold: 0.7 }, "acme/stored"), {
    model: "acme/configured",
    threshold: 0.7,
    source: "options",
  });

  assert.deepEqual(resolveSettings(NO_OPTIONS, "acme/stored"), {
    model: "acme/stored",
    threshold: SAFETY_THRESHOLD,
    source: "override",
  });

  assert.deepEqual(resolveSettings(NO_OPTIONS, undefined), {
    model: DEFAULT_MODEL,
    threshold: SAFETY_THRESHOLD,
    source: "default",
  });
});

test("an invalid option model is ignored instead of shadowing a stored override", () => {
  assert.deepEqual(resolveSettings({ model: "not-a-model", threshold: undefined }, "acme/stored"), {
    model: "acme/stored",
    threshold: SAFETY_THRESHOLD,
    source: "override",
  });

  assert.deepEqual(resolveSettings({ model: "a/ b", threshold: undefined }, undefined), {
    model: DEFAULT_MODEL,
    threshold: SAFETY_THRESHOLD,
    source: "default",
  });
});

test("option padding is trimmed before it is resolved", () => {
  assert.deepEqual(resolveSettings({ model: "  acme/configured \n", threshold: undefined }, undefined), {
    model: "acme/configured",
    threshold: SAFETY_THRESHOLD,
    source: "options",
  });
});

test("a valid threshold reaches the config, an invalid one falls back", () => {
  for (const threshold of [0.001, 0.5, 1]) {
    assert.equal(resolveSettings({ model: undefined, threshold }, undefined).threshold, threshold, String(threshold));
  }

  for (const threshold of [0, -0.1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(
      resolveSettings({ model: undefined, threshold }, undefined).threshold,
      SAFETY_THRESHOLD,
      String(threshold),
    );
  }

  // A config file is JSON, but a future caller may hand over a string; it must not become a threshold.
  const fromJson = resolveSettings({ model: undefined, threshold: "0.5" as unknown as number }, undefined);
  assert.equal(fromJson.threshold, SAFETY_THRESHOLD);
});

test("isModelString accepts provider/model and rejects every malformed half", () => {
  const accepted = [
    "a/b",
    "opencode/jev-1.13-free",
    // Model.Ref splits on the first slash, so a variant suffix stays inside the model id.
    "opencode/jev-1.13-free/high",
    `a/${"b".repeat(198)}`,
  ];
  for (const value of accepted) assert.equal(isModelString(value), true, value);

  const rejected = [
    "",
    " ",
    "provider",
    "/model",
    "provider/",
    "pro vider/model",
    "provider/mod el",
    "provider\t/model",
    "provider/model\n",
    `a/${"b".repeat(199)}`,
  ];
  for (const value of rejected) assert.equal(isModelString(value), false, JSON.stringify(value));

  for (const value of [undefined, null, 42, true, {}, [], ["a/b"]]) {
    assert.equal(isModelString(value), false, String(value));
  }
});

test("normalizeModel trims padding and rejects everything isModelString rejects", () => {
  assert.equal(normalizeModel("  acme/model  "), "acme/model");
  assert.equal(normalizeModel("\nacme/model\t"), "acme/model");
  assert.equal(normalizeModel("acme/model"), "acme/model");

  for (const value of ["", "   ", "acme", "/model", "acme/", "acme/ model", 42, null, undefined, {}, []]) {
    assert.equal(normalizeModel(value), undefined, String(value));
  }
});

test("parseModelOverride reads only a trimmed model string from a record", () => {
  assert.equal(parseModelOverride({ model: "acme/model" }), "acme/model");
  assert.equal(parseModelOverride({ model: "  acme/model  " }), "acme/model");
  assert.equal(parseModelOverride({ model: "acme/model", writtenAt: 1 }), "acme/model");

  const junk: ReadonlyArray<unknown> = [
    null,
    undefined,
    [],
    ["acme/model"],
    "acme/model",
    42,
    true,
    {},
    { model: 42 },
    { model: null },
    { model: "" },
    { model: "   " },
    { model: "not-a-model" },
    { model: "acme/ model" },
    { model: "/model" },
    { model: "acme/" },
    { other: "acme/model" },
  ];
  for (const value of junk) {
    assert.equal(parseModelOverride(value), undefined, JSON.stringify(value));
  }
});

test("isThreshold accepts probabilities in (0, 1] only", () => {
  for (const value of [0.001, 0.5, 0.9, 1]) assert.equal(isThreshold(value), true, String(value));
  for (const value of [0, -0.1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined]) {
    assert.equal(isThreshold(value), false, String(value));
  }
});

test("readOptions parses the config, ignoring invalid model and threshold values", () => {
  assert.deepEqual(readOptions({}), {
    enabled: true,
    logRaw: false,
    logDirectory: undefined,
    auditDirectory: undefined,
    model: undefined,
    threshold: undefined,
    includeSystemContext: false,
  });

  assert.deepEqual(
    readOptions({
      enabled: false,
      log_raw: true,
      log_dir: "/tmp/logs",
      audit_dir: "/tmp/audit",
      model: "  acme/model  ",
      threshold: 0.75,
      include_system_context: true,
    }),
    {
      enabled: false,
      logRaw: true,
      logDirectory: "/tmp/logs",
      auditDirectory: "/tmp/audit",
      model: "acme/model",
      threshold: 0.75,
      includeSystemContext: true,
    },
  );

  assert.equal(readOptions({ threshold: 1 }).threshold, 1);

  for (const threshold of [Number.NaN, 0, -1, 1.1, Number.POSITIVE_INFINITY, "0.5", null]) {
    assert.equal(readOptions({ threshold }).threshold, undefined, String(threshold));
  }

  for (const model of ["", "   ", "provider", "/model", "provider/", "provider/ model", 42, null, {}, []]) {
    assert.equal(readOptions({ model }).model, undefined, String(model));
  }
});

test("readOptions keeps the kill switch off only for an explicit false", () => {
  assert.equal(readOptions({ enabled: false }).enabled, false);
  assert.equal(readOptions({ enabled: true }).enabled, true);
  assert.equal(readOptions({ enabled: "false" }).enabled, true);
  assert.equal(readOptions({ enabled: 0 }).enabled, true);
});

test("readOptions includes system context only for an explicit true", () => {
  assert.equal(readOptions({ include_system_context: true }).includeSystemContext, true);
  for (const value of [false, "true", 1, null, undefined, {}]) {
    assert.equal(readOptions({ include_system_context: value }).includeSystemContext, false, String(value));
  }
});
