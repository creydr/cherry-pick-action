import { describe, it, expect } from "vitest";
import { replacePlaceholders, getMentionedIssueRefs } from "../utils.js";
import type { PullRequest } from "../github.js";

describe("replacePlaceholders", () => {
  const main: Pick<PullRequest, "body" | "user" | "number" | "title"> = {
    number: 42,
    title: "Fix bug",
    body: "Fixes #123",
    user: { login: "author" },
  };

  it("replaces pull_number", () => {
    expect(replacePlaceholders("PR #${pull_number}", main, "main")).toBe(
      "PR #42",
    );
  });

  it("replaces pull_title", () => {
    expect(
      replacePlaceholders("[${target_branch}] ${pull_title}", main, "main"),
    ).toBe("[main] Fix bug");
  });

  it("replaces pull_author", () => {
    expect(replacePlaceholders("by ${pull_author}", main, "main")).toBe(
      "by author",
    );
  });

  it("replaces target_branch", () => {
    expect(replacePlaceholders("to ${target_branch}", main, "release-1")).toBe(
      "to release-1",
    );
  });

  it("replaces pull_description", () => {
    expect(replacePlaceholders("${pull_description}", main, "main")).toBe(
      "Fixes #123",
    );
  });

  it("handles null body", () => {
    const prWithNullBody = { ...main, body: null };
    expect(
      replacePlaceholders("${pull_description}", prWithNullBody, "main"),
    ).toBe("");
  });
});

describe("getMentionedIssueRefs", () => {
  it("finds issue references in text", () => {
    expect(getMentionedIssueRefs("Fixes #123")).toEqual(["#123"]);
  });

  it("finds GitHub issue URLs", () => {
    expect(
      getMentionedIssueRefs("Fixes https://github.com/owner/repo/issues/123 "),
    ).toEqual(["owner/repo#123"]);
  });

  it("returns empty array for null body", () => {
    expect(getMentionedIssueRefs(null)).toEqual([]);
  });

  it("returns empty array when no issues found", () => {
    expect(getMentionedIssueRefs("no issues here")).toEqual([]);
  });

  it("finds adjacent issue references without dropping any", () => {
    expect(getMentionedIssueRefs("#1 #2 #3")).toEqual(["#1", "#2", "#3"]);
  });

  it("finds adjacent GitHub issue URLs without dropping any", () => {
    expect(
      getMentionedIssueRefs(
        "https://github.com/owner/repo/issues/1 https://github.com/owner/repo/issues/2",
      ),
    ).toEqual(["owner/repo#1", "owner/repo#2"]);
  });
});
