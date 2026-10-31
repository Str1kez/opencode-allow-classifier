/**
 * The portable half of the `config`/`setModel` contract: server and TUI both import this module, so
 * it must stay free of anything server-only. Every schema goes through `Schema.toStandardSchemaV1`
 * because the TUI client is constrained to `Rpc.PortableDefinition` and raw Effect schemas are not
 * Standard Schema.
 */

import { Schema } from "effect";
import { Rpc } from "@opencode/plugin/rpc";
import { PLUGIN_ID } from "./id.ts";
import { SETTING_SOURCES } from "./settings.ts";

const portable = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.toStandardSchemaV1(schema);

const ConfigSchema = Schema.Struct({
  model: Schema.String,
  threshold: Schema.Number,
  source: Schema.Literals(SETTING_SOURCES),
});

/** What both methods return: the effective settings, never the raw override. */
export type ClassifierConfig = Schema.Schema.Type<typeof ConfigSchema>;

export const ClassifierRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    /**
     * Takes an empty object rather than `undefined` so the call site reads `config({})` and a future
     * field can be added without changing every caller.
     */
    config: {
      input: portable(Schema.Struct({})),
      output: portable(ConfigSchema),
    },
    setModel: {
      input: portable(Schema.Struct({ model: Schema.String })),
      output: portable(ConfigSchema),
      errors: {
        /** The reference is malformed or no such model is in the catalog. */
        UnknownModel: portable(Schema.Struct({ model: Schema.String })),
        /** The catalog or the storage layer failed; nothing was saved. */
        Unavailable: portable(Schema.Struct({ reason: Schema.String })),
      },
    },
  },
  events: {},
});
