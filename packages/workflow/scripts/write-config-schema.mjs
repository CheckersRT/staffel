import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STAFFEL_CONFIG_SCHEMA_V1 } from "../dist/core/config-schema.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const schemaDirectory = path.join(packageRoot, "dist", "schemas");
const schemaPath = path.join(schemaDirectory, "staffel-config-v1.json");

fs.mkdirSync(schemaDirectory, { recursive: true });
fs.writeFileSync(
  schemaPath,
  `${JSON.stringify(STAFFEL_CONFIG_SCHEMA_V1, null, 2)}\n`
);
