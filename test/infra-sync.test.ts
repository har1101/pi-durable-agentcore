import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { WAKE_INDEX } from "../dist/wake-sweeper.cjs";

const BEGIN = "// BEGIN GENERATED wake-sweeper (npm run sync:infra)";
const END = "// END GENERATED wake-sweeper";

describe("inline wake sweeper in the bootstrap template", () => {
  it("is exactly dist/wake-sweeper.cjs, fits the ZipFile limit, and queries the template's index", async () => {
    const yaml = await readFile("infra/github-oidc-bootstrap.yaml", "utf8");
    const code = (await readFile("dist/wake-sweeper.cjs", "utf8")).trimEnd();
    const lines = yaml.split("\n");
    const begin = lines.findIndex((line) => line.trim() === BEGIN);
    const end = lines.findIndex((line, index) => index > begin && line.trim() === END);
    expect(begin, "BEGIN marker").toBeGreaterThan(-1);
    expect(end, "END marker").toBeGreaterThan(begin);

    const indent = lines[begin]!.slice(0, lines[begin]!.indexOf(BEGIN));
    const block = lines.slice(begin, end + 1).map((line) =>
      line.startsWith(indent) ? line.slice(indent.length) : line,
    );
    expect(block.slice(1, -1).join("\n"), "run `npm run sync:infra`").toBe(code);
    expect(Buffer.byteLength(code)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(block.join("\n"))).toBeLessThanOrEqual(4096);
    expect(WAKE_INDEX).toBe("WakeIndex");
    expect(yaml).toMatch(new RegExp(`IndexName:\\s*${WAKE_INDEX}\\b`));
  });
});
