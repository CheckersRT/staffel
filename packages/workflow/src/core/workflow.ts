import type {
  StaffelConfig,
  StageDefinition,
  TransitionClassification,
  ValidatedTransition,
  WorkflowDefinition,
} from "./types.js";
import { validateTransitionReason } from "./validation.js";

type WorkflowInput = StaffelConfig | WorkflowDefinition;

function workflowOf(input: WorkflowInput): WorkflowDefinition {
  return "workflow" in input ? input.workflow : input;
}

export function getStage(
  input: WorkflowInput,
  stageName: string
): StageDefinition {
  const workflow = workflowOf(input);
  const enabled = workflow.enabledStages.includes(stageName);
  const stage = workflow.stages[stageName];

  if (!enabled || !stage) {
    throw new Error(
      `Unsupported stage: ${stageName}. Supported: ${workflow.enabledStages.join(", ")}`
    );
  }

  return stage;
}

export function getBeginDestination(
  input: WorkflowInput,
  stageName: string
): string {
  const destination = getStage(input, stageName).beginsAs;
  if (!destination) {
    throw new Error(`Stage ${stageName} has no begin transition.`);
  }
  getStage(input, destination);
  return destination;
}

export function getExpectedPacketStages(
  input: WorkflowInput,
  stageName: string
): readonly string[] {
  const stage = getStage(input, stageName);
  return stage.packetStages ?? [stageName];
}

export function isRoleActiveStage(
  input: WorkflowInput,
  stageName: string
): boolean {
  return ["active", "lifecycle"].includes(getStage(input, stageName).kind);
}

export function classifyTransition(
  input: WorkflowInput,
  from: string,
  to: string
): TransitionClassification {
  const workflow = workflowOf(input);
  getStage(workflow, from);

  const blockedReason = workflow.blockedDestinations[to];
  if (blockedReason) {
    throw new Error(blockedReason);
  }

  getStage(workflow, to);
  return (workflow.normalTransitions[from] ?? []).includes(to)
    ? "normal"
    : "exceptional";
}

export function validateTransition(
  input: WorkflowInput,
  from: string,
  to: string,
  reason?: unknown
): ValidatedTransition {
  const classification = classifyTransition(input, from, to);
  return {
    from,
    to,
    classification,
    reason: validateTransitionReason(classification, reason),
  };
}
