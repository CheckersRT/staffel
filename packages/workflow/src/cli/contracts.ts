export const STAFFEL_CLI_VERSION = "0.1.0-alpha.1";

export const CLI_COMMANDS = [
  "init",
  "dispatch",
  "stage",
  "handoff",
  "tracker",
  "status",
  "doctor",
  "capabilities",
  "migrate",
] as const;

export type CliCommand = typeof CLI_COMMANDS[number];

export const STAFFEL_COMMAND_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:staffel:schema:cli-command:v1",
  title: "Staffel CLI command v1",
  type: "string",
  enum: CLI_COMMANDS,
} as const;

export const STAFFEL_INPUT_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:staffel:schema:cli-input:v1",
  title: "Staffel CLI input v1",
  type: "object",
  additionalProperties: {
    type: ["string", "boolean"],
  },
  properties: {
    command: { $ref: "urn:staffel:schema:cli-command:v1" },
    repository: { type: "string", minLength: 1 },
    config: { type: "string", minLength: 1 },
    json: { type: "boolean" },
    dryRun: { type: "boolean" },
  },
  required: ["command"],
} as const;

export const STAFFEL_ERROR_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:staffel:schema:cli-error:v1",
  title: "Staffel CLI error v1",
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "exitCode"],
  properties: {
    code: { type: "string", pattern: "^[a-z][a-z0-9_.-]+$" },
    message: { type: "string", minLength: 1 },
    exitCode: { type: "integer", minimum: 1 },
    details: {},
  },
} as const;

export const STAFFEL_OUTPUT_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:staffel:schema:cli-output:v1",
  title: "Staffel CLI output envelope v1",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "command", "result"],
      properties: {
        ok: { const: true },
        command: { $ref: "urn:staffel:schema:cli-command:v1" },
        result: {},
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["ok", "command", "error"],
      properties: {
        ok: { const: false },
        command: { type: ["string", "null"] },
        error: { $ref: "urn:staffel:schema:cli-error:v1" },
      },
    },
  ],
} as const;

export const STAFFEL_CAPABILITIES_V1 = Object.freeze({
  contractVersion: 1,
  cliVersion: STAFFEL_CLI_VERSION,
  output: "json",
  interactive: false,
  exitCodes: Object.freeze({
    success: 0,
    usage: 2,
    config: 3,
    state: 4,
    tracker: 5,
    internal: 10,
  }),
  schemas: Object.freeze({
    command: STAFFEL_COMMAND_SCHEMA_V1.$id,
    input: STAFFEL_INPUT_SCHEMA_V1.$id,
    output: STAFFEL_OUTPUT_SCHEMA_V1.$id,
    error: STAFFEL_ERROR_SCHEMA_V1.$id,
  }),
  commands: Object.freeze([
    capability("init", ["initialize"], true, []),
    capability("dispatch", ["agent:dispatch"], true, ["task", "name", "type", "stage", "goal"]),
    capability("stage", ["begin", "agent:stage"], true, ["task"]),
    capability("handoff", ["agent:handoff"], true, ["task", "to"]),
    capability("tracker", ["trello:agent"], true, ["task"]),
    capability("status", [], false, []),
    capability("doctor", [], false, []),
    capability("capabilities", [], false, []),
    capability("migrate", [], true, ["from"]),
  ]),
});

function capability(
  name: CliCommand,
  aliases: readonly string[],
  dryRun: boolean,
  requiredOptions: readonly string[]
) {
  return Object.freeze({
    name,
    aliases: Object.freeze([...aliases]),
    requiredOptions: Object.freeze([...requiredOptions]),
    supportsDryRun: dryRun,
    inputSchema: STAFFEL_INPUT_SCHEMA_V1.$id,
    outputSchema: STAFFEL_OUTPUT_SCHEMA_V1.$id,
    errorSchema: STAFFEL_ERROR_SCHEMA_V1.$id,
  });
}
