import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetInput, mockSetFailed, mockSetOutput } = vi.hoisted(() => ({
  mockGetInput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockSetOutput: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
}));

vi.mock("../cherry-pick.js", () => ({
  CherryPick: class {
    async run() {}
  },
  experimentalDefaults: { conflict_resolution: "fail" },
}));

vi.mock("../github.js", () => ({
  Github: vi.fn(),
}));

vi.mock("../git.js", () => ({
  Git: vi.fn(),
}));

function makeInputs(
  overrides?: Record<string, string>,
): Record<string, string> {
  return {
    github_token: "test-token",
    github_workspace: "/tmp/workspace",
    git_committer_name: "Test",
    git_committer_email: "test@test.com",
    comment_pattern: "",
    pull_description: "desc",
    pull_title: "title",
    branch_name: "branch",
    add_labels: "",
    copy_labels_pattern: "",
    cherry_picking: "auto",
    merge_commits: "fail",
    copy_assignees: "false",
    copy_milestone: "false",
    copy_all_reviewers: "false",
    copy_requested_reviewers: "false",
    add_author_as_assignee: "false",
    add_author_as_reviewer: "false",
    add_reviewers: "",
    add_team_reviewers: "",
    auto_merge_enabled: "false",
    auto_merge_method: "merge",
    source_pr_number: "",
    experimental: "{}",
    ...overrides,
  };
}

function setupInputs(overrides?: Record<string, string>) {
  const inputs = makeInputs(overrides);
  mockGetInput.mockImplementation((name: string) => inputs[name] ?? "");
}

describe("main.ts input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("fails on invalid cherry_picking value", async () => {
    setupInputs({ cherry_picking: "invalid" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("cherry_picking"),
    );
  });

  it("fails on invalid merge_commits value", async () => {
    setupInputs({ merge_commits: "invalid" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("merge_commits"),
    );
  });

  it("fails on invalid auto_merge_method value", async () => {
    setupInputs({ auto_merge_method: "invalid" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("auto_merge_method"),
    );
  });

  it("fails when both copy_requested_reviewers and add_author_as_reviewer are enabled", async () => {
    setupInputs({
      copy_requested_reviewers: "true",
      add_author_as_reviewer: "true",
    });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("copy_requested_reviewers"),
    );
  });

  it("fails when both copy_all_reviewers and copy_requested_reviewers are enabled", async () => {
    setupInputs({
      copy_all_reviewers: "true",
      copy_requested_reviewers: "true",
    });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("copy_all_reviewers"),
    );
  });

  it("fails on invalid experimental JSON", async () => {
    setupInputs({ experimental: "not-json" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("experimental"),
    );
  });

  it("fails on invalid conflict_resolution value", async () => {
    setupInputs({
      experimental: '{"conflict_resolution":"invalid"}',
    });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("conflict_resolution"),
    );
  });

  it("fails on non-integer source_pr_number", async () => {
    setupInputs({ source_pr_number: "abc" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("source_pr_number"),
    );
  });

  it("fails on zero source_pr_number", async () => {
    setupInputs({ source_pr_number: "0" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("source_pr_number"),
    );
  });

  it("fails on negative source_pr_number", async () => {
    setupInputs({ source_pr_number: "-1" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("source_pr_number"),
    );
  });

  it("fails on invalid comment_pattern regex", async () => {
    setupInputs({ comment_pattern: "[" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("comment_pattern"),
    );
  });

  it("fails on invalid copy_labels_pattern regex", async () => {
    setupInputs({ copy_labels_pattern: "[" });
    await import("../main.js");
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("copy_labels_pattern"),
    );
  });

  it("does not fail with valid inputs", async () => {
    setupInputs();
    await import("../main.js");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
