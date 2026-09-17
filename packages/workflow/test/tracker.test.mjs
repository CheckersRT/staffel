import assert from "node:assert/strict";
import test from "node:test";

import referenceFixture from "../../../fixtures/reference/staffel.config.mjs";
import {
  NoTrackerAdapter,
  TrelloTrackerAdapter,
  parseStaffelConfig,
  validateStaffelConfig,
} from "../dist/index.js";

const listNames = [...new Set(Object.values(referenceFixture.workflow.stages).map((stage) => stage.trackerList))];
const trelloConfigValue = {
  ...structuredClone(referenceFixture),
  tracker: {
    provider: "trello",
    boardIdEnvironmentVariable: "TEST_BOARD",
    apiKeyEnvironmentVariable: "TEST_KEY",
    tokenEnvironmentVariable: "TEST_TOKEN",
    listIds: Object.fromEntries(listNames.map((name, index) => [name, `list-${index}`])),
    taskTypeLabelIds: {
      Feature: "label-feature",
      Maintenance: "label-maintenance",
    },
  },
};
const trelloConfig = parseStaffelConfig(trelloConfigValue).tracker;
const credentials = { boardId: "board", apiKey: "key", token: "token" };
const task = {
  taskId: "42",
  title: "#42 Contract fixture",
  taskType: "Maintenance",
  packetPath: ".staffel/tasks/0042-contract-fixture.md",
};

test("Trello configuration requires complete, unambiguous list mappings", () => {
  const missing = structuredClone(trelloConfigValue);
  delete missing.tracker.listIds["Ready for Implementation"];
  const issues = validateStaffelConfig(missing);
  assert.ok(issues.some((issue) => issue.path.includes("Ready for Implementation")));

  const duplicate = structuredClone(trelloConfigValue);
  duplicate.tracker.listIds["Ready for Implementation"] = duplicate.tracker.listIds.Implementing;
  assert.ok(validateStaffelConfig(duplicate).some((issue) => issue.message.includes("duplicate ids")));

  const missingLabel = structuredClone(trelloConfigValue);
  delete missingLabel.tracker.taskTypeLabelIds.Maintenance;
  assert.ok(validateStaffelConfig(missingLabel).some((issue) => issue.path.endsWith(".Maintenance")));
});

test("no-tracker mode implements the tracker contract without external calls", async () => {
  const adapter = new NoTrackerAdapter();
  assert.deepEqual(await adapter.inspect(task), { position: null, reference: null });
  assert.deepEqual(await adapter.sync(task, "Ready for Code Review"), {
    position: "Ready for Code Review",
    reference: null,
  });
  assert.equal((await adapter.diagnose())[0].code, "tracker.disabled");
});

test("Trello adapter inspects and moves an existing card through injected HTTP", async () => {
  const currentList = trelloConfig.listIds.Implementing;
  const destinationList = trelloConfig.listIds["Ready for Code Review"];
  const http = new RecordingHttp([
    { status: 200, body: [{ id: "card-42", name: task.title, idList: currentList }] },
    { status: 200, body: [{ id: "card-42", name: task.title, idList: currentList }] },
    { status: 200, body: { id: "card-42", name: task.title, idList: destinationList, url: "https://trello.test/c/card-42" } },
  ]);
  const adapter = new TrelloTrackerAdapter(trelloConfig, credentials, http, "https://trello.test/1");

  assert.deepEqual(await adapter.inspect(task), {
    position: "Implementing",
    reference: "trello:card-42",
  });
  const synced = await adapter.sync(task, "Ready for Code Review");
  assert.deepEqual(synced, {
    position: "Ready for Code Review",
    reference: "https://trello.test/c/card-42",
  });
  assert.equal(http.requests.length, 3);
  assert.equal(http.requests[2].method, "PUT");
  assert.equal(http.requests[2].body.idList, destinationList);
  assert.match(http.requests[0].url, /\/boards\/board\/cards/);
  assert.match(http.requests[0].url, /key=key/);
  assert.match(http.requests[0].url, /token=token/);
});

test("Trello adapter creates a labeled card without reaching a live board", async () => {
  const destinationList = trelloConfig.listIds["Ready for Implementation"];
  const http = new RecordingHttp([
    { status: 200, body: [] },
    {
      status: 200,
      body: { id: "new-card", name: task.title, idList: destinationList, url: "https://trello.test/c/new" },
    },
  ]);
  const adapter = new TrelloTrackerAdapter(trelloConfig, credentials, http, "https://trello.test/1");
  const synced = await adapter.sync(task, "Ready for Implementation");

  assert.equal(synced.reference, "https://trello.test/c/new");
  assert.equal(http.requests[1].method, "POST");
  assert.deepEqual(http.requests[1].body, {
    idList: destinationList,
    name: task.title,
    desc: `Staffel task packet: ${task.packetPath}`,
    idLabels: "label-maintenance",
  });
});

test("Trello adapter fails before HTTP when configured credentials are absent", async () => {
  const http = new RecordingHttp([]);
  const adapter = new TrelloTrackerAdapter(
    trelloConfig,
    { boardId: "", apiKey: "", token: "" },
    http,
    "https://trello.test/1"
  );
  await assert.rejects(adapter.inspect(task), (error) => error.code === "tracker.credentials_missing");
  assert.equal(http.requests.length, 0);
});

class RecordingHttp {
  requests = [];

  constructor(responses) {
    this.responses = [...responses];
  }

  request(input) {
    this.requests.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("Unexpected tracker HTTP request.");
    return Promise.resolve(response);
  }
}
