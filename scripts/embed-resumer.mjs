// Copies infra/resumer/index.cjs into the bootstrap template's inline ZipFile.
// `--check` exits 1 when the template is stale; the test suite runs it.
import { readFileSync, writeFileSync } from "node:fs";

const templatePath = new URL("../infra/github-oidc-bootstrap.yaml", import.meta.url);
const source = readFileSync(new URL("../infra/resumer/index.cjs", import.meta.url), "utf8");
const template = readFileSync(templatePath, "utf8");
const begin = "        ZipFile: |\n";
const end = "      # end ResumerFunction code\n";
const start = template.indexOf(begin);
const stop = template.indexOf(end);
if (start === -1 || stop === -1) throw new Error("ZipFile markers not found in the template");
if (source.length > 4096) throw new Error(`resumer is ${source.length} chars; ZipFile allows 4096`);

const indented = source
  .trimEnd()
  .split("\n")
  .map((line) => (line === "" ? "" : `          ${line}`))
  .join("\n");
const updated = `${template.slice(0, start + begin.length)}${indented}\n${template.slice(stop)}`;

if (process.argv.includes("--check")) {
  if (updated !== template) {
    console.error("infra/github-oidc-bootstrap.yaml is stale: run node scripts/embed-resumer.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(templatePath, updated);
}
