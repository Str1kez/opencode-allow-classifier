/**
 * `/classifier` — the only TUI surface of the plugin. It is a command-only definition with no JSX:
 * `@opencode/plugin/tui` re-exports the host's Solid bindings at runtime, and `solid-js` is a
 * host-provided peer that is absent from this package, so only its types may be imported here.
 */

import { dirname, resolve } from "node:path";
import type { DialogSelectOption } from "@opencode/plugin/tui/context";
import type { Context, Definition } from "@opencode/plugin/tui/plugin";
import { PLUGIN_ID } from "./id.ts";
import { ClassifierRpc, type ClassifierConfig } from "./rpc.ts";

const COMMAND_ID = "str1kez.allow-classifier.model";
const TOAST_TITLE = "Allow classifier";
const SYSTEM_ONE_CATEGORY = "System One";

type LocationRef = NonNullable<Context["location"]>;
type ModelInfo = Awaited<ReturnType<Context["client"]["model"]["list"]>>["data"][number];
type ToastOptions = Parameters<Context["ui"]["toast"]["show"]>[0];

/**
 * A toast is the last thing a command does. A renderer failure must not turn a saved pick into an
 * unhandled rejection, so every call goes through here.
 */
function safeToast(ctx: Context, options: ToastOptions): void {
  try {
    ctx.ui.toast.show(options);
  } catch {
    // The pick is already saved; a failed toast must not surface as an unhandled rejection.
  }
}

/** RPC failures are plain `{ type, message, data? }` objects, not `Error` instances. */
function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message: unknown = error.message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Unknown error";
}

function isJev(model: ModelInfo): boolean {
  return model.providerID === "opencode" && (model.modelID === "jev" || model.modelID.startsWith("jev-"));
}

/**
 * Groups models by the provider's display name when the catalog has one, otherwise by id. The TUI
 * can know the models while the provider list is still empty, and the picker must not depend on both.
 */
function providerNames(ctx: Context, location: LocationRef): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const provider of ctx.data.location.provider.list(location) ?? []) {
    // The catalog is server data crossing a schema boundary; treat a missing name as no name.
    if (typeof provider.name === "string" && provider.name.length > 0) names.set(provider.id, provider.name);
  }
  return names;
}

/**
 * The dialog renders categories in first-appearance order, so Jev models are collected into a
 * separate bucket and prepended. Some providers surface the same `provider/model` twice; the first
 * entry wins so the picker shows no duplicates.
 */
function selectOptions(
  models: readonly ModelInfo[],
  names: ReadonlyMap<string, string>,
): DialogSelectOption<string>[] {
  const seen = new Set<string>();
  const systemOne: DialogSelectOption<string>[] = [];
  const others: DialogSelectOption<string>[] = [];

  for (const model of models) {
    // A disabled entry cannot be selected on the host; offering it would only produce a failed pick.
    if (model.enabled === false) continue;

    const value = `${model.providerID}/${model.modelID}`;
    if (seen.has(value)) continue;
    seen.add(value);

    const option: DialogSelectOption<string> = {
      value,
      title: typeof model.name === "string" && model.name.length > 0 ? model.name : model.modelID,
      description: value,
      category: isJev(model) ? SYSTEM_ONE_CATEGORY : (names.get(model.providerID) ?? model.providerID),
    };

    if (isJev(model)) systemOne.push(option);
    else others.push(option);
  }

  return [...systemOne, ...others];
}

/**
 * Chat models cannot answer the `decisions` operation the classifier calls; the host exposes the
 * decision-capable models as a separate catalog type. The TUI data store only holds prompt models,
 * so this asks the server directly.
 */
async function decisionCatalog(ctx: Context, location: LocationRef): Promise<readonly ModelInfo[]> {
  const catalog = await ctx.client.model.list({
    location: { directory: location.directory },
    types: ["decision"],
  });
  return catalog.data;
}

/**
 * `options.model` in `opencode.jsonc` beats the override on purpose. The pick is still stored, so
 * the toast has to say the effective model did not change; a plain success here would send the
 * user looking for a bug that is not there.
 */
function reportSaved(ctx: Context, picked: string, saved: ClassifierConfig): void {
  if (saved.source === "options" && saved.model !== picked) {
    safeToast(ctx, {
      variant: "warning",
      title: TOAST_TITLE,
      message: `Saved ${picked}, but the config pins ${saved.model}`,
    });
    return;
  }

  safeToast(ctx, {
    variant: "success",
    title: TOAST_TITLE,
    message: `Classifier model: ${saved.model}`,
  });
}

async function chooseModel(ctx: Context): Promise<void> {
  try {
    const location = ctx.location ?? ctx.data.location.default();
    const call = { location: { directory: location.directory } };
    const rpc = ctx.client.rpc(ClassifierRpc);

    const config = await rpc.config({}, call);

    const models = await decisionCatalog(ctx, location);
    if (models.length === 0) {
      safeToast(ctx, { variant: "error", title: TOAST_TITLE, message: "Decision model catalog is empty" });
      return;
    }

    const picked = await ctx.ui.dialog.select<string>({
      title: "Classifier model",
      current: config.model,
      options: selectOptions(models, providerNames(ctx, location)),
    });
    if (picked === undefined) return;

    const saved = await rpc.setModel({ model: picked }, call);
    reportSaved(ctx, picked, saved);
  } catch (error) {
    safeToast(ctx, { variant: "error", title: TOAST_TITLE, message: errorMessage(error) });
  }
}

type PluginOptions = Readonly<Record<string, unknown>>;

/**
 * The host honors a command's `enabled` callback for dispatch but still lists the command in slash
 * completion, so a disabled plugin must not register the layer at all. It also does not forward the
 * plugin entry's options to `ctx.options` in TUI processes (OpenCode 2.2.4), so when the host gives
 * us no `enabled` value, read it from the config the server resolved. `plugin.list` identifies our
 * entry and the last matching config entry wins, mirroring the host's own dedupe.
 */
async function isDisabled(ctx: Context): Promise<boolean> {
  const enabled = ctx.options["enabled"];
  if (enabled === false) return true;
  if (enabled !== undefined) return false;

  try {
    return (await configPluginOptions(ctx))?.["enabled"] === false;
  } catch {
    // Never hide the command because the server could not answer: a transient config failure would
    // make a working command vanish. The server half still has its own kill switch.
    return false;
  }
}

async function configPluginOptions(ctx: Context): Promise<PluginOptions | undefined> {
  const listed = await ctx.client.plugin.list();
  const own = listed.data.find((plugin) => plugin.id === PLUGIN_ID);
  if (own === undefined) return undefined;

  const source = own.source;
  const target =
    source.type === "package" ? source.target : source.type === "local" ? source.path : undefined;
  if (target === undefined) return undefined;

  let options: PluginOptions | undefined;
  for (const entry of await ctx.client.config.get()) {
    if (entry.type !== "document") continue;
    const base = entry.path === undefined ? process.cwd() : dirname(entry.path);
    for (const configured of entry.info.plugins ?? []) {
      if (typeof configured === "string") continue;
      if (configured.package !== target && resolve(base, configured.package) !== target) continue;
      options = configured.options;
    }
  }
  return options;
}

const TuiPlugin: Definition = {
  id: PLUGIN_ID,
  setup: async (ctx) => {
    if (await isDisabled(ctx)) return;

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: COMMAND_ID,
          title: "Classifier: choose model",
          group: "Allow classifier",
          palette: true,
          slash: { name: "classifier" },
          run: async () => {
            await chooseModel(ctx);
          },
        },
      ],
    }));
  },
};

export default TuiPlugin;
