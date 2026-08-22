import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/core");

test("the core has no filesystem, Git, tracker, or Codex imports", () => {
  const files = fs.readdirSync(core).filter((name) => name.endsWith(".ts"));
  for (const file of files) {
    const source = fs.readFileSync(path.join(core, file), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, file);
    assert.doesNotMatch(source, /from\s+["'](?:fs|path|child_process|simple-git|@octokit|trello|codex)/i, file);
  }
});
