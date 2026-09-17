export const STAFFEL_CONFIG_VERSION = 1 as const;

export const STAFFEL_CONFIG_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:staffel:schema:config:v1",
  title: "Staffel configuration v1",
  type: "object",
  additionalProperties: false,
  required: [
    "configVersion",
    "compatibility",
    "repository",
    "workflow",
    "tracker",
  ],
  properties: {
    configVersion: { const: STAFFEL_CONFIG_VERSION },
    compatibility: {
      type: "object",
      additionalProperties: false,
      required: ["workflow", "cli", "plugin"],
      properties: {
        workflow: {
          type: "string",
          pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$",
        },
        cli: {
          type: "string",
          pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$",
        },
        plugin: {
          type: "string",
          pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$",
        },
      },
    },
    repository: {
      type: "object",
      additionalProperties: false,
      required: ["timezone", "branchPrefix", "taskTypes", "paths"],
      properties: {
        timezone: { type: "string", minLength: 1 },
        branchPrefix: { type: "string", minLength: 1 },
        taskTypes: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        paths: {
          type: "object",
          additionalProperties: false,
          required: ["registry", "taskPackets", "liveLedger", "rolePlaybooks"],
          properties: {
            registry: { type: "string", minLength: 1 },
            taskPackets: { type: "string", minLength: 1 },
            liveLedger: { type: "string", minLength: 1 },
            rolePlaybooks: { type: "string", minLength: 1 },
          },
        },
      },
    },
    workflow: {
      type: "object",
      additionalProperties: false,
      required: [
        "enabledStages",
        "stages",
        "normalTransitions",
        "blockedDestinations",
      ],
      properties: {
        enabledStages: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        stages: {
          type: "object",
          minProperties: 1,
          additionalProperties: { $ref: "#/$defs/stage" },
        },
        normalTransitions: {
          type: "object",
          additionalProperties: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
        blockedDestinations: {
          type: "object",
          additionalProperties: { type: "string", minLength: 1 },
        },
      },
    },
    tracker: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["provider"],
          properties: { provider: { const: "none" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "provider",
            "boardIdEnvironmentVariable",
            "apiKeyEnvironmentVariable",
            "tokenEnvironmentVariable",
            "listIds",
            "taskTypeLabelIds",
          ],
          properties: {
            provider: { const: "trello" },
            boardIdEnvironmentVariable: { type: "string", minLength: 1 },
            apiKeyEnvironmentVariable: { type: "string", minLength: 1 },
            tokenEnvironmentVariable: { type: "string", minLength: 1 },
            listIds: {
              type: "object",
              minProperties: 1,
              additionalProperties: { type: "string", minLength: 1 },
            },
            taskTypeLabelIds: {
              type: "object",
              minProperties: 1,
              additionalProperties: { type: "string", minLength: 1 },
            },
          },
        },
      ],
    },
  },
  $defs: {
    stage: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "nextRole", "rolePlaybook", "trackerList", "status"],
      properties: {
        kind: { enum: ["ready", "active", "result", "lifecycle"] },
        nextRole: { type: "string", minLength: 1 },
        rolePlaybook: { type: "string", minLength: 1 },
        trackerList: { type: "string", minLength: 1 },
        status: { type: "string", minLength: 1 },
        beginsAs: { type: "string", minLength: 1 },
        packetStages: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
