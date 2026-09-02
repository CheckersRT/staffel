import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STAFFEL_CONFIG_SCHEMA_V1 } from "../dist/core/config-schema.js";
import {
  STAFFEL_COMMAND_SCHEMA_V1,
  STAFFEL_ERROR_SCHEMA_V1,
  STAFFEL_INPUT_SCHEMA_V1,
  STAFFEL_OUTPUT_SCHEMA_V1,
} from "../dist/cli/contracts.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const schemaDirectory = path.join(packageRoot, "dist", "schemas");
fs.mkdirSync(schemaDirectory, { recursive: true });
for (const [name, schema] of [
  ["staffel-config-v1.json", STAFFEL_CONFIG_SCHEMA_V1],
  ["staffel-command-v1.json", STAFFEL_COMMAND_SCHEMA_V1],
  ["staffel-input-v1.json", STAFFEL_INPUT_SCHEMA_V1],
  ["staffel-output-v1.json", STAFFEL_OUTPUT_SCHEMA_V1],
  ["staffel-error-v1.json", STAFFEL_ERROR_SCHEMA_V1],
]) {
  fs.writeFileSync(path.join(schemaDirectory, name), `${JSON.stringify(schema, null, 2)}\n`);
}
