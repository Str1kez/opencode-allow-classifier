import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DialogSelectOption,
  KeymapCommand,
  KeymapLayer,
} from "@opencode/plugin/tui/context";
import type { Context as TuiContext, Definition } from "@opencode/plugin/tui/plugin";
import { ClassifierRpc, type ClassifierConfig } from "../src/rpc.ts";
import TuiPlugin from "../src/tui.ts";

interface FakeModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly name?: string;
  readonly enabled?: boolean;
}

interface FakeProvider {
  readonly id: string;
  readonly name?: string;
}

interface SelectOptions {
  readonly title: string;
  readonly current?: string;
  readonly options: ReadonlyArray<DialogSelectOption<string>>;
}

interface ToastOptions {
  readonly variant?: "info" | "success" | "warning" | "error";
  readonly title?: string;
  readonly message: string;
}

interface World {
  readonly config?: ClassifierConfig;
  readonly saved?: ClassifierConfig;
  readonly cancel?: boolean;
  readonly pick?: string;
  readonly models?: ReadonlyArray<FakeModel>;
  readonly providers?: ReadonlyArray<FakeProvider>;
  readonly modelListError?: unknown;
  readonly configError?: unknown;
  readonly setModelError?: unknown;
  readonly dialogError?: unknown;
  readonly toastError?: unknown;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly noLocation?: boolean;
  readonly defaultLocation?: { readonly directory: string };
}

const LOCATION = { directory: "/Users/test/project" };
const FALLBACK_LOCATION = { directory: "/Users/test/fallback" };

const DEFAULT_MODELS: ReadonlyArray<FakeModel> = [
  { providerID: "acme", modelID: "classified", name: "Classified" },
  { providerID: "opencode", modelID: "jev-1.13-free" },
  { providerID: "opencode", modelID: "jev-1.13", name: "Jev 1.13" },
  { providerID: "acme", modelID: "classified", name: "Duplicate" },
  { providerID: "solo", modelID: "only" },
  { providerID: "acme", modelID: "disabled", enabled: false },
  { providerID: "opencode", modelID: "my-jev" },
];

const DEFAULT_CONFIG: ClassifierConfig = {
  model: "acme/classified",
  threshold: 0.9,
  source: "override",
};

interface Harness {
  readonly context: TuiContext;
  readonly command: KeymapCommand;
  readonly configCalls: number;
  readonly configLocations: ReadonlyArray<{ readonly directory: string }>;
  readonly defaultLocationCalls: number;
  readonly setModelInputs: ReadonlyArray<{ readonly model: string }>;
  readonly modelListCalls: number;
  readonly modelListInputs: ReadonlyArray<{
    readonly location: { readonly directory: string };
    readonly types: ReadonlyArray<string>;
  }>;
  readonly dialogs: ReadonlyArray<SelectOptions>;
  readonly toasts: ReadonlyArray<ToastOptions>;
  readonly uiAccesses: ReadonlyArray<string>;
  run(): Promise<void>;
}

/** Builds a TUI context with only the surfaces `src/tui.ts` is allowed to touch. */
async function start(world: World = {}): Promise<Harness> {
  let layerFactory: (() => KeymapLayer) | undefined;
  let configCalls = 0;
  let defaultLocationCalls = 0;
  let modelListCalls = 0;
  const catalog = world.models ?? DEFAULT_MODELS;
  const configLocations: Array<{ directory: string }> = [];
  const setModelInputs: Array<{ model: string }> = [];
  const modelListInputs: Array<{
    location: { directory: string };
    types: ReadonlyArray<string>;
  }> = [];
  const dialogs: SelectOptions[] = [];
  const toasts: ToastOptions[] = [];
  const uiAccesses: string[] = [];

  const defaultLocation = world.defaultLocation ?? LOCATION;
  const expectedLocation = world.noLocation === true ? defaultLocation : LOCATION;
  const config = world.config ?? DEFAULT_CONFIG;
  const saved = world.saved ?? { ...config, model: world.pick ?? config.model };

  const ui = new Proxy(
    {
      dialog: {
        select: async (options: SelectOptions): Promise<string | undefined> => {
          if (world.dialogError !== undefined) throw world.dialogError;
          dialogs.push(options);
          return world.cancel === true ? undefined : (world.pick ?? config.model);
        },
      },
      toast: {
        show: (options: ToastOptions): void => {
          // Record the attempt before throwing so the test can prove the command tried to report.
          toasts.push(options);
          if (world.toastError !== undefined) throw world.toastError;
        },
      },
    },
    {
      get(target, property, receiver) {
        uiAccesses.push(String(property));
        return Reflect.get(target, property, receiver);
      },
    },
  );

  const context = {
    options: world.options ?? { enabled: true },
    location: world.noLocation === true ? undefined : LOCATION,
    app: {},
    renderer: {},
    attention: {},
    theme: {},
    themeMode: {},
    markdown: {},
    storage: {},
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        layerFactory = factory;
      },
    },
    ui,
    client: {
      rpc: (definition: unknown) => {
        assert.equal(definition, ClassifierRpc);
        return {
          config: async (input: unknown, call: unknown) => {
            configCalls += 1;
            assert.deepEqual(input, {});
            assert.deepEqual(call, { location: expectedLocation });
            configLocations.push((call as { location: { directory: string } }).location);
            if (world.configError !== undefined) throw world.configError;
            return config;
          },
          setModel: async (input: { model: string }) => {
            setModelInputs.push(input);
            if (world.setModelError !== undefined) throw world.setModelError;
            return saved;
          },
        };
      },
      model: {
        list: async (input: {
          location: { directory: string };
          types: ReadonlyArray<string>;
        }) => {
          modelListCalls += 1;
          modelListInputs.push(input);
          if (world.modelListError !== undefined) throw world.modelListError;
          return { data: catalog };
        },
      },
    },
    data: {
      location: {
        default: () => {
          defaultLocationCalls += 1;
          return defaultLocation;
        },
        model: {
          // The picker must use the decision catalog from the server, never the prompt models.
          list: () => {
            throw new Error("the prompt model catalog must not be used by the picker");
          },
        },
        provider: {
          list: () =>
            world.providers ?? [
              { id: "opencode", name: "OpenCode" },
              { id: "acme", name: "Acme" },
            ],
        },
      },
    },
  } as unknown as TuiContext;

  const cleanup = await TuiPlugin.setup(context);
  assert.equal(cleanup, undefined);
  assert.ok(layerFactory, "setup did not register a keymap layer");

  const layer = layerFactory();
  assert.equal(layer.mode, "global");
  assert.equal(layer.commands?.length, 1);

  return {
    context,
    command: layer.commands[0]!,
    get configCalls() {
      return configCalls;
    },
    configLocations,
    get defaultLocationCalls() {
      return defaultLocationCalls;
    },
    setModelInputs,
    get modelListCalls() {
      return modelListCalls;
    },
    modelListInputs,
    dialogs,
    toasts,
    uiAccesses,
    async run() {
      await layer.commands![0]!.run();
    },
  };
}

interface Registration {
  readonly layerCalls: number;
  readonly commands: ReadonlyArray<KeymapCommand>;
  readonly serverCalls: number;
}

/** Registers the plugin with the smallest context that can observe keymap registration. */
async function register(options: Readonly<Record<string, unknown>>): Promise<Registration> {
  const layers: KeymapLayer[] = [];
  let serverCalls = 0;

  const context = {
    options,
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        layers.push(factory());
      },
    },
    client: {
      plugin: {
        list: () => {
          serverCalls += 1;
          throw new Error("plugin.list must not be called when the host passes options");
        },
      },
      config: {
        get: () => {
          serverCalls += 1;
          throw new Error("config.get must not be called when the host passes options");
        },
      },
    },
  } as unknown as TuiContext;

  const cleanup = await TuiPlugin.setup(context);
  assert.equal(cleanup, undefined);

  return {
    layerCalls: layers.length,
    commands: layers.flatMap((layer) => layer.commands ?? []),
    serverCalls,
  };
}

interface ConfigWorld {
  readonly options?: Readonly<Record<string, unknown>>;
  readonly documents?: ReadonlyArray<unknown>;
  readonly pluginListError?: Error;
}

/** Simulates a host that does not forward plugin options to `ctx.options`. */
async function registerFromConfig(world: ConfigWorld = {}): Promise<Registration> {
  const layers: KeymapLayer[] = [];
  let serverCalls = 0;
  const documents = world.documents ?? [
    {
      type: "document",
      path: "/config/opencode.jsonc",
      info: {
        plugins: [{ package: "./plugin", options: world.options ?? { enabled: true } }],
      },
    },
  ];

  const context = {
    options: {},
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        layers.push(factory());
      },
    },
    client: {
      plugin: {
        list: async () => {
          serverCalls += 1;
          if (world.pluginListError !== undefined) throw world.pluginListError;
          return {
            location: {},
            data: [
              {
                id: "str1kez.allow-classifier",
                source: { type: "local", path: "/config/plugin" },
              },
            ],
          };
        },
      },
      config: {
        get: async () => {
          serverCalls += 1;
          return documents;
        },
      },
    },
  } as unknown as TuiContext;

  const cleanup = await TuiPlugin.setup(context);
  assert.equal(cleanup, undefined);

  return {
    layerCalls: layers.length,
    commands: layers.flatMap((layer) => layer.commands ?? []),
    serverCalls,
  };
}

const tuiDefinition: Definition = TuiPlugin;

test("TUI exports a definition for the plugin id", () => {
  assert.equal(tuiDefinition.id, "str1kez.allow-classifier");
});

test("the command is discoverable as /classifier and shows the current model", async () => {
  const harness = await start();

  assert.equal(harness.command.slash?.name, "classifier");
  assert.equal(harness.command.palette, true);
  assert.equal(harness.command.group, "Allow classifier");
  assert.equal(typeof harness.command.title, "string");

  await harness.run();

  assert.equal(harness.configCalls, 1);
  assert.deepEqual(harness.modelListInputs, [
    { location: LOCATION, types: ["decision"] },
  ]);
  assert.equal(harness.dialogs.length, 1);
  assert.equal(harness.dialogs[0]!.title, "Classifier model");
  assert.equal(harness.dialogs[0]!.current, "acme/classified");
});

test("Jev models are grouped under System One, first, deduped, and providers get names", async () => {
  const harness = await start();

  await harness.run();

  const options = harness.dialogs[0]!.options;
  assert.deepEqual(
    options.map((option) => option.value),
    ["opencode/jev-1.13-free", "opencode/jev-1.13", "acme/classified", "solo/only", "opencode/my-jev"],
  );
  assert.deepEqual(
    options.map((option) => option.category),
    ["System One", "System One", "Acme", "solo", "OpenCode"],
  );
  assert.equal(options[0]!.title, "jev-1.13-free");
  assert.equal(options[1]!.title, "Jev 1.13");
  assert.equal(options[2]!.title, "Classified");
  assert.equal(new Set(options.map((option) => option.value)).size, options.length);
});

test("picking a model saves exactly that value and reports the effective model", async () => {
  const harness = await start({
    pick: "acme/classified",
    saved: { model: "acme/classified", threshold: 0.9, source: "override" },
  });

  await harness.run();

  assert.deepEqual(harness.setModelInputs, [{ model: "acme/classified" }]);
  assert.deepEqual(harness.toasts, [
    {
      variant: "success",
      title: "Allow classifier",
      message: "Classifier model: acme/classified",
    },
  ]);
});

test("when options pin a different model the toast warns instead of claiming success", async () => {
  const harness = await start({
    pick: "acme/classified",
    saved: { model: "acme/pinned", threshold: 0.9, source: "options" },
  });

  await harness.run();

  assert.deepEqual(harness.setModelInputs, [{ model: "acme/classified" }]);
  assert.equal(harness.toasts.length, 1);
  assert.equal(harness.toasts[0]!.variant, "warning");
  assert.match(harness.toasts[0]!.message, /Saved acme\/classified/);
  assert.match(harness.toasts[0]!.message, /config pins acme\/pinned/);
});

test("the decision catalog is fetched once from the server for the bound location", async () => {
  const harness = await start();

  await harness.run();

  assert.equal(harness.modelListCalls, 1);
  assert.deepEqual(harness.modelListInputs, [
    { location: LOCATION, types: ["decision"] },
  ]);
  assert.equal(harness.dialogs.length, 1);
  assert.equal(harness.dialogs[0]!.options.length, 5);
});

test("an empty decision catalog reports an error and never opens the dialog", async () => {
  const harness = await start({ models: [] });

  await harness.run();

  assert.equal(harness.modelListCalls, 1);
  assert.equal(harness.dialogs.length, 0);
  assert.deepEqual(harness.toasts, [
    { variant: "error", title: "Allow classifier", message: "Decision model catalog is empty" },
  ]);
});

test("a failed decision catalog read becomes an error toast and never rejects run()", async () => {
  const harness = await start({
    modelListError: { type: "rpc.unavailable", message: "catalog is down" },
  });

  await harness.run();

  assert.equal(harness.dialogs.length, 0);
  assert.deepEqual(harness.toasts, [
    { variant: "error", title: "Allow classifier", message: "catalog is down" },
  ]);
});

test("cancelling the dialog saves nothing and stays silent", async () => {
  const harness = await start({ cancel: true });

  await harness.run();

  assert.equal(harness.dialogs.length, 1);
  assert.deepEqual(harness.setModelInputs, []);
  assert.deepEqual(harness.toasts, []);
});

test("a plain RPC failure becomes an error toast and never rejects run()", async () => {
  const harness = await start({
    configError: { type: "rpc.unavailable", message: "server is down", data: { reason: "no socket" } },
  });

  await harness.run();

  assert.deepEqual(harness.toasts, [
    { variant: "error", title: "Allow classifier", message: "server is down" },
  ]);
  assert.equal(harness.dialogs.length, 0);
});

test("a throwing dialog becomes an error toast and never rejects run()", async () => {
  const harness = await start({ dialogError: new Error("dialog exploded") });

  await harness.run();

  assert.deepEqual(harness.toasts, [
    { variant: "error", title: "Allow classifier", message: "dialog exploded" },
  ]);
  assert.deepEqual(harness.setModelInputs, []);
});

test("a throwing toast is swallowed, including the error toast after a failed save", async () => {
  const harness = await start({
    setModelError: { type: "rpc.internal", message: "save failed" },
    toastError: new Error("toast exploded"),
  });

  await harness.run();

  assert.equal(harness.toasts.length, 1);
  assert.equal(harness.toasts[0]!.variant, "error");
  assert.equal(harness.toasts[0]!.message, "save failed");
});

test("the command never touches the prompt model surface", async () => {
  const harness = await start();

  assert.equal("session" in harness.context, false);
  assert.equal(harness.uiAccesses.includes("model"), false);

  await harness.run();

  assert.deepEqual([...new Set(harness.uiAccesses)].sort(), ["dialog", "toast"]);
});

test("enabled options register exactly one layer with the /classifier command", async () => {
  const registration = await register({ enabled: true });

  assert.equal(registration.layerCalls, 1);
  assert.equal(registration.commands.length, 1);
  assert.equal(registration.commands[0]!.slash?.name, "classifier");
  assert.equal(registration.serverCalls, 0);
});

test("a disabled plugin registers no slash or palette command at all", async () => {
  const registration = await register({ enabled: false });

  assert.equal(registration.layerCalls, 0);
  assert.deepEqual(registration.commands, []);
  assert.equal(registration.serverCalls, 0);
});

test("an empty TUI options object is resolved against the server config", async () => {
  const disabled = await registerFromConfig({ options: { enabled: false } });
  const enabled = await registerFromConfig();

  assert.equal(disabled.layerCalls, 0);
  assert.equal(disabled.serverCalls, 2);
  assert.equal(enabled.layerCalls, 1);
  assert.equal(enabled.commands[0]!.slash?.name, "classifier");
});

test("a disabled entry for another plugin does not disable /classifier", async () => {
  const registration = await registerFromConfig({
    documents: [
      {
        type: "document",
        path: "/config/opencode.jsonc",
        info: {
          plugins: [
            { package: "/config/other", options: { enabled: false } },
            { package: "./plugin", options: { enabled: true } },
          ],
        },
      },
    ],
  });

  assert.equal(registration.layerCalls, 1);
});

test("the last matching config entry decides the kill switch", async () => {
  const registration = await registerFromConfig({
    documents: [
      {
        type: "document",
        path: "/global/opencode.jsonc",
        info: { plugins: [{ package: "/config/plugin", options: { enabled: false } }] },
      },
      {
        type: "document",
        path: "/project/opencode.jsonc",
        info: { plugins: [{ package: "/config/plugin", options: { enabled: true } }] },
      },
    ],
  });

  assert.equal(registration.layerCalls, 1);
});

test("a failed plugin lookup leaves the command registered", async () => {
  const registration = await registerFromConfig({
    pluginListError: new Error("server unavailable"),
  });

  assert.equal(registration.layerCalls, 1);
  assert.equal(registration.serverCalls, 1);
});

test("disabled catalog models never reach the picker", async () => {
  const harness = await start();

  await harness.run();

  const values = harness.dialogs[0]!.options.map((option) => option.value);
  assert.equal(values.includes("acme/disabled"), false);
  assert.equal(values.length, 5);
});

test("a model whose id merely contains jev is not System One", async () => {
  const harness = await start({
    models: [
      { providerID: "opencode", modelID: "jev-1.13" },
      { providerID: "opencode", modelID: "my-jev" },
    ],
  });

  await harness.run();

  const options = harness.dialogs[0]!.options;
  assert.deepEqual(
    options.map((option) => [option.value, option.category]),
    [
      ["opencode/jev-1.13", "System One"],
      ["opencode/my-jev", "OpenCode"],
    ],
  );
});

test("without a bound location the command asks the data layer for the default", async () => {
  const harness = await start({ noLocation: true, defaultLocation: FALLBACK_LOCATION });

  await harness.run();

  assert.equal(harness.defaultLocationCalls, 1);
  assert.deepEqual(harness.configLocations, [FALLBACK_LOCATION]);
  assert.deepEqual(harness.modelListInputs, [
    { location: FALLBACK_LOCATION, types: ["decision"] },
  ]);
  assert.equal(harness.configCalls, 1);
  assert.equal(harness.dialogs.length, 1);
});
