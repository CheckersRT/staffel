import type { StaffelTemplatesV1 } from "./types.js";

export const STAFFEL_TEMPLATE_VERSION = 1 as const;

export const BLANK_TASK_REGISTRY_TEMPLATE = `# Task Registry

Durable accepted work. Active coordination belongs in the live ledger.

`;

export const BLANK_TASK_PACKET_TEMPLATE = `#{{taskId}} {{taskName}}

Detailed progress is tracked in the live ledger, not in this file.

## Stable Brief

- Task: #{{taskId}} {{taskName}}
- Type: {{taskType}}

## References

- Handoff: {{handoff}}
- Plan: {{plan}}
- ADR: {{adr}}
- Pull request: {{pullRequest}}

## Current Stage

- Stage: {{stage}}
- Next role: {{nextRole}}
- Role playbook: {{rolePlaybook}}

## Stage Brief

- Goal: {{goal}}

## Task Registry Entry

{{registryEntry}}

## Start Prompt

{{startPrompt}}
`;

export const BLANK_LIVE_LEDGER_TEMPLATE = `# Agent Workstreams

## Active Workstreams

## Recently Closed
`;

export const STAFFEL_TEMPLATES_V1: StaffelTemplatesV1 = Object.freeze({
  version: STAFFEL_TEMPLATE_VERSION,
  taskRegistry: BLANK_TASK_REGISTRY_TEMPLATE,
  taskPacket: BLANK_TASK_PACKET_TEMPLATE,
  liveLedger: BLANK_LIVE_LEDGER_TEMPLATE,
});
