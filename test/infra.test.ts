import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

function resourceBlock(template: string, logicalId: string): string {
  const start = template.indexOf(`\n  ${logicalId}:\n`);
  expect(start, logicalId).toBeGreaterThan(-1);
  const next = template.slice(start + 1).search(/\n  [A-Za-z]+:\n|\nOutputs:\n/);
  return template.slice(start + 1, start + 1 + next);
}

describe("bootstrap template", () => {
  it("embeds the tested resumer source verbatim", async () => {
    await execFileAsync(process.execPath, ["scripts/embed-resumer.mjs", "--check"]);
    const source = await readFile("infra/resumer/index.cjs", "utf8");
    expect(source.length).toBeLessThanOrEqual(4096);
  });

  it("keeps replacement-sensitive resources as they were deployed", async () => {
    const template = await readFile("infra/github-oidc-bootstrap.yaml", "utf8");
    const table = resourceBlock(template, "SessionStore");
    expect(table).toContain("DeletionPolicy: Retain");
    expect(table).toContain("UpdateReplacePolicy: Retain");
    expect(table).toContain("TableName: !Ref SessionTableName");
    expect(table).not.toContain("GlobalSecondaryIndexes");
    expect(table.match(/AttributeName: (pk|sk)/g)).toHaveLength(4);
    expect(resourceBlock(template, "ContainerRepository")).toContain(
      "RepositoryName: !Ref EcrRepositoryName",
    );
    expect(resourceBlock(template, "GitHubOidcProvider")).toContain(
      "Condition: CreateGitHubOidcProvider",
    );
    for (const role of ["AgentRuntimeExecutionRole", "GitHubDeployRole"]) {
      const block = resourceBlock(template, role);
      expect(block).not.toMatch(/RoleName:|Path:|Condition: CreateResumer/);
    }
    for (const added of ["ResumerRole", "ResumerFunction", "ResumerSchedule", "ResumerSchedulePermission"]) {
      expect(resourceBlock(template, added)).toContain("Condition: CreateResumer");
    }
  });
});
