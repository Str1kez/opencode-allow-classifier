/**
 * Effective classifier settings shared by the config file and the TUI override.
 *
 * Everything here is pure and may be fed untrusted values: `ctx.storage` and `opencode.jsonc` are
 * both outside the plugin's control, and a corrupt value must degrade to the default, never throw.
 */

import { DEFAULT_MODEL, SAFETY_THRESHOLD } from "./classifier.ts";

/** `ctx.storage` key holding the TUI-selected model. Namespaced by the host, so the bare name is enough. */
export const MODEL_OVERRIDE_KEY = "model_override";

/** Longer than any real `provider/model` id; anything above it is junk, not a model reference. */
export const MAX_MODEL_LENGTH = 200;

/**
 * A minute is already far beyond a usable permission prompt: the hook holds the shell call for the whole
 * budget, so a bigger number in the config is a typo, not an intent.
 */
export const MAX_TIMEOUT_MS = 60_000;

export const SETTING_SOURCES = ["options", "override", "default"] as const;

/** Where the effective model came from. `options` wins over `override`, which wins over the default. */
export type SettingSource = (typeof SETTING_SOURCES)[number];

export interface EffectiveSettings {
  readonly model: string;
  readonly threshold: number;
  readonly source: SettingSource;
}

/** The subset of the plugin options that shapes the resolution order. */
export interface SettingsInput {
  readonly model: string | undefined;
  readonly threshold: number | undefined;
}

/**
 * A catalog entry is addressed as `provider/model`. Both halves must be present, and whitespace is
 * never part of an id — `Model.Ref.parse` would happily split `" a/b"` into a provider that cannot
 * exist and a model lookup that always misses.
 */
export function isModelString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_MODEL_LENGTH) return false;
  if (/\s/.test(value)) return false;

  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

/** Trims first: a hand-edited config may pad the value, the stored form never is. */
export function normalizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return isModelString(trimmed) ? trimmed : undefined;
}

/** The threshold is a probability: `0` would allow nothing, values above `1` are not probabilities. */
export function isThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

/**
 * The timeout is a positive whole number of milliseconds inside `(0, MAX_TIMEOUT_MS]`. Zero or a
 * fraction is a config mistake, not a budget: zero would expire before the call starts, and a
 * fractional budget is meaningless at permission-prompt scale.
 */
export function isTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

/**
 * Reads the override back from storage. A value written by an older version, a stray manual edit or
 * a partially written record are all just "no override".
 */
export function parseModelOverride(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  return normalizeModel((value as Record<string, unknown>)["model"]);
}

function pickModel(
  configured: string | undefined,
  override: string | undefined,
): { readonly model: string; readonly source: SettingSource } {
  if (configured !== undefined) return { model: configured, source: "options" };
  if (override !== undefined) return { model: override, source: "override" };
  return { model: DEFAULT_MODEL, source: "default" };
}

/**
 * Options beat the TUI override on purpose: `opencode.jsonc` is the operator's decision, the picker
 * is a convenience. A stored override stays stored even while the config shadows it, so clearing the
 * config falls back to the user's last pick instead of the default.
 *
 * Both inputs are re-validated here because callers may bypass `readOptions` (tests, future call
 * sites); an invalid threshold falls back rather than allowing every call.
 */
export function resolveSettings(options: SettingsInput, override: string | undefined): EffectiveSettings {
  const configured = normalizeModel(options.model);
  const stored = normalizeModel(override);
  const { model, source } = pickModel(configured, stored);

  return {
    model,
    source,
    threshold: isThreshold(options.threshold) ? options.threshold : SAFETY_THRESHOLD,
  };
}
