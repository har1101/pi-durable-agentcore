// Writes dist/wake-sweeper.cjs into the Lambda's inline ZipFile block; test/infra-sync.test.ts checks they match.
import { readFileSync, writeFileSync } from "node:fs";

const BEGIN = "// BEGIN GENERATED wake-sweeper (npm run sync:infra)";
const END = "// END GENERATED wake-sweeper";
const yamlPath = new URL("../infra/github-oidc-bootstrap.yaml", import.meta.url);
const codePath = new URL("../dist/wake-sweeper.cjs", import.meta.url);

const lines = readFileSync(yamlPath, "utf8").split("\n");
const begin = lines.findIndex((line) => line.trim() === BEGIN);
const end = lines.findIndex((line, index) => index > begin && line.trim() === END);
if (begin === -1 || end === -1) {
  throw new Error(`${yamlPath.pathname} has no "${BEGIN}" ... "${END}" block`);
}
const indent = lines[begin].slice(0, lines[begin].indexOf(BEGIN));
const code = readFileSync(codePath, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => (line === "" ? "" : indent + line));
writeFileSync(
  yamlPath,
  [...lines.slice(0, begin + 1), ...code, ...lines.slice(end)].join("\n"),
);
process.stdout.write(`synced ${code.length} lines of dist/wake-sweeper.cjs into ${yamlPath.pathname}\n`);
