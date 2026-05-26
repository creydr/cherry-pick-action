import { describe, it, expect } from "vitest";
import { generateDependabotYaml } from "./update-dependabot.ts";

describe("generateDependabotYaml", () => {
  it("generates config with no release branches", () => {
    const result = generateDependabotYaml([]);
    expect(result).toContain("version: 2");
    expect(result).toContain("package-ecosystem: npm");
    expect(result).toContain("package-ecosystem: github-actions");
    expect(result).not.toContain("target-branch");
  });

  it("does not group npm on main", () => {
    const result = generateDependabotYaml([]);
    const npmSection = result.split("package-ecosystem: github-actions")[0];
    expect(npmSection).not.toContain("groups:");
  });

  it("groups github-actions on main", () => {
    const result = generateDependabotYaml([]);
    expect(result).toContain(
      'github-actions:\n        patterns:\n          - "*"',
    );
  });

  it("adds entries for a release branch", () => {
    const result = generateDependabotYaml(["release-1.0"]);
    expect(result).toContain('target-branch: "release-1.0"');

    const parts = result.split('target-branch: "release-1.0"');
    expect(parts).toHaveLength(3); // before + npm entry + github-actions entry
  });

  it("groups both ecosystems on release branches", () => {
    const result = generateDependabotYaml(["release-1.0"]);
    const releasePart = result.split('target-branch: "release-1.0"')[1];
    expect(releasePart).toContain("npm:\n        patterns:");
  });

  it("adds commit-message prefix for release branches", () => {
    const result = generateDependabotYaml(["release-1.0"]);
    expect(result).toContain('prefix: "[release-1.0]"');
  });

  it("does not add commit-message prefix for main", () => {
    const result = generateDependabotYaml([]);
    expect(result).not.toContain("commit-message:");
    expect(result).not.toContain("prefix:");
  });

  it("preserves input order of release branches", () => {
    const result = generateDependabotYaml([
      "release-2.0",
      "release-1.0",
      "release-1.1",
    ]);

    const targetBranches = [
      ...result.matchAll(/target-branch: "([^"]+)"/g),
    ].map((m) => m[1]);
    expect(targetBranches).toEqual([
      "release-2.0",
      "release-2.0",
      "release-1.0",
      "release-1.0",
      "release-1.1",
      "release-1.1",
    ]);
  });

  it("produces valid YAML structure", () => {
    const result = generateDependabotYaml(["release-1.0"]);
    expect(result).toMatch(/^version: 2\nupdates:\n/);
    expect(result.endsWith("\n")).toBe(true);
  });
});
