import { describe, it, expect, vi, beforeEach } from "vitest";
import { CherryPick } from "../cherry-pick.js";
import { GitRefNotFoundError } from "../git.js";
import { MergeStrategy } from "../github.js";
import { FakeGithub, requestError } from "./helpers/fake-github.js";
import { createMockGit } from "./helpers/mock-git.js";
import { makeConfig } from "./helpers/config.js";

vi.mock("@actions/core", () => ({
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

import * as core from "@actions/core";

describe("CherryPick.run() orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("comment-based targeting", () => {
    it("issue_comment event: uses comment body to determine target", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(github.createdPRs[0].base).toBe("main");
    });

    it("pull_request_target event: scans all PR comments for targets", async () => {
      const github = new FakeGithub({
        prComments: [
          "/cherry-pick release-1",
          "some unrelated comment",
          "/cherry-pick release-2",
        ],
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(2);
      const bases = github.createdPRs.map((pr) => pr.base);
      expect(bases).toContain("release-1");
      expect(bases).toContain("release-2");
    });

    it("no matching comments: no PRs created, no comments", async () => {
      const github = new FakeGithub({
        prComments: ["some unrelated comment"],
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(0);
      expect(github.comments).toHaveLength(0);
    });

    it("duplicate targets in comments: deduplicates", async () => {
      const github = new FakeGithub({
        prComments: ["/cherry-pick main", "/cherry-pick main"],
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
    });

    it("single comment with multiple target branches: creates PRs for each", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick release-1.0 release-1.1",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(2);
      const bases = github.createdPRs.map((pr) => pr.base);
      expect(bases).toContain("release-1.0");
      expect(bases).toContain("release-1.1");
    });

    it("comment with multiple cherry-pick lines: creates PRs for all targets", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick release-1.0\n/cherry-pick release-2.0",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(2);
      const bases = github.createdPRs.map((pr) => pr.base);
      expect(bases).toContain("release-1.0");
      expect(bases).toContain("release-2.0");
    });
  });

  describe("core behavior", () => {
    it("happy path: creates cherry-pick PR and posts success comment", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("Successfully created cherry-pick PR"),
        }),
      );
      expect(core.setOutput).toHaveBeenCalledWith("was_successful", true);

      expect(github.milestonesByPR.size).toBe(0);
      expect(github.assigneesByPR.size).toBe(0);
      expect(github.reviewersByPR.size).toBe(0);
      expect(github.teamReviewersByPR.size).toBe(0);
      expect(github.labelsByPR.size).toBe(0);
      expect(github.autoMergeByPR.size).toBe(0);
    });

    it("unmerged PR: posts 'not merged' comment, no PRs", async () => {
      const github = new FakeGithub({
        merged: false,
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(0);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("Only merged pull requests"),
        }),
      );
    });

    it("partial failure: one PR created, one failure, was_successful = false", async () => {
      let cherryPickCallCount = 0;
      const github = new FakeGithub({
        prComments: ["/cherry-pick release-1", "/cherry-pick release-2"],
      });
      const git = createMockGit({
        cherryPick: vi.fn().mockImplementation(async () => {
          cherryPickCallCount++;
          if (cherryPickCallCount === 1) return null;
          throw new Error("cherry-pick failed");
        }),
      });
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(core.setOutput).toHaveBeenCalledWith("was_successful", false);
    });

    it("RequestError in post-creation step: continues with remaining steps", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: {
          milestone: { number: 1, id: 1, title: "v1" },
          assignees: [{ login: "user1", id: 1 }],
        },
      });
      github.failOn("setMilestone", requestError(403));
      const git = createMockGit();
      const config = makeConfig({
        copy_milestone: true,
        copy_assignees: true,
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(github.milestonesByPR.size).toBe(0);
      expect(github.assigneesByPR.get(100)).toEqual(["user1"]);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("Successfully created cherry-pick PR"),
        }),
      );
      expect(core.setOutput).toHaveBeenCalledWith("was_successful", true);
    });
  });

  describe("fetch", () => {
    it("target branch fetch fails with GitRefNotFoundError: posts failure comment, continues", async () => {
      const github = new FakeGithub({
        prComments: ["/cherry-pick nonexistent", "/cherry-pick main"],
      });
      const git = createMockGit({
        fetch: vi.fn().mockImplementation(async (ref: string) => {
          if (ref === "nonexistent") {
            throw new GitRefNotFoundError("not found", "nonexistent");
          }
        }),
      });
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("couldn't find remote ref"),
        }),
      );
      expect(github.createdPRs).toHaveLength(1);
    });
  });

  describe("cherry-pick", () => {
    it("pull_request_head cherry-picking: uses PR commits, not merge commit", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: {
          commitShas: ["sha1", "sha2"],
          mergeCommitSha: "squash-sha",
        },
        mergeStrategyResult: MergeStrategy.SQUASHED,
      });
      const git = createMockGit();
      const config = makeConfig({
        commits: {
          cherry_picking: "pull_request_head",
          merge_commits: "fail",
        },
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(git.cherryPick).toHaveBeenCalledWith(
        ["sha1", "sha2"],
        expect.anything(),
        expect.anything(),
      );
    });

    it("auto cherry-picking with MERGECOMMIT strategy: uses PR commits", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: {
          commitShas: ["sha1", "sha2"],
          mergeCommitSha: "merge-sha",
        },
        mergeStrategyResult: MergeStrategy.MERGECOMMIT,
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(git.cherryPick).toHaveBeenCalledWith(
        ["sha1", "sha2"],
        expect.anything(),
        expect.anything(),
      );
    });

    it("auto cherry-picking with REBASED strategy: uses rebased commits from range", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: {
          commitShas: ["sha1", "sha2"],
          mergeCommitSha: "rebase-sha",
        },
        mergeStrategyResult: MergeStrategy.REBASED,
      });
      const git = createMockGit({
        findCommitsInRange: vi
          .fn()
          .mockResolvedValue(["rebased-sha1", "rebased-sha2"]),
      });
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(git.findCommitsInRange).toHaveBeenCalledWith(
        "rebase-sha~2..rebase-sha",
        expect.anything(),
      );
      expect(git.cherryPick).toHaveBeenCalledWith(
        ["rebased-sha1", "rebased-sha2"],
        expect.anything(),
        expect.anything(),
      );
    });

    it("auto cherry-picking with null merge_commit_sha: falls back to PR commits", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: {
          commitShas: ["sha1", "sha2"],
          mergeCommitSha: null,
        },
        mergeStrategyResult: MergeStrategy.UNKNOWN,
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(git.cherryPick).toHaveBeenCalledWith(
        ["sha1", "sha2"],
        expect.anything(),
        expect.anything(),
      );
    });

    it("cherry-pick fails: posts failure comment with manual instructions", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit({
        cherryPick: vi.fn().mockRejectedValue(new Error("cherry-pick failed")),
      });
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(0);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("unable to cherry-pick"),
        }),
      );
    });

    it("cherry-pick with conflicts (draft mode): creates draft PR, posts conflict comment", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit({
        cherryPick: vi.fn().mockResolvedValue(["abc123"]),
      });
      const config = makeConfig({
        experimental: { conflict_resolution: "draft_commit_conflicts" },
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs[0].draft).toBe(true);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("remaining conflicts"),
        }),
      );
    });
  });

  describe("push", () => {
    it("push fails, branch exists: recovers and creates PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit({
        push: vi.fn().mockResolvedValue(1),
      });
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
    });

    it("push fails, branch doesn't exist: posts failure comment", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit({
        push: vi.fn().mockResolvedValue(1),
        fetch: vi
          .fn()
          .mockResolvedValue(undefined)
          .mockImplementation(async (ref: string) => {
            if (ref.startsWith("cherry-pick-")) {
              throw new GitRefNotFoundError("not found", ref);
            }
          }),
      });
      const config = makeConfig();

      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(0);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("Git push to origin failed"),
        }),
      );
    });
  });

  describe("PR creation", () => {
    it("PR already exists (422): skips silently", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        existingPRBranches: ["cherry-pick-42-to-main"],
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      const failureComment = github.comments.find(
        (c) => c.body.includes("failed") || c.body.includes("Failed"),
      );
      expect(failureComment).toBeUndefined();
    });

    it("custom PR title template: replaces placeholders", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs[0]).toEqual(
        expect.objectContaining({ title: "[Cherry-pick main] Test PR" }),
      );
    });
  });

  describe("assignees", () => {
    it("copy assignees: assigns same users to cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { assignees: [{ login: "user1", id: 1 }] },
      });
      const git = createMockGit();
      const config = makeConfig({ copy_assignees: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.assigneesByPR.get(100)).toEqual(["user1"]);
    });

    it("add author as assignee: assigns PR author to cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({ add_author_as_assignee: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.assigneesByPR.get(100)).toEqual(["author"]);
    });
  });

  describe("reviewers", () => {
    it("copy requested reviewers: requests same reviewers on cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { requested_reviewers: [{ login: "reviewer1" }] },
      });
      const git = createMockGit();
      const config = makeConfig({ copy_requested_reviewers: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(["reviewer1"]);
    });

    it("copy all reviewers: requests both requested and submitted reviewers", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { requested_reviewers: [{ login: "reviewer1" }] },
        reviews: [{ user: { login: "reviewer2" } }],
      });
      const git = createMockGit();
      const config = makeConfig({ copy_all_reviewers: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(
        expect.arrayContaining(["reviewer1", "reviewer2"]),
      );
      expect(github.reviewersByPR.get(100)).toHaveLength(2);
    });

    it("copy all reviewers: deduplicates reviewers appearing in both requested and submitted", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { requested_reviewers: [{ login: "reviewer1" }] },
        reviews: [{ user: { login: "reviewer1" } }],
      });
      const git = createMockGit();
      const config = makeConfig({ copy_all_reviewers: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(["reviewer1"]);
    });

    it("copy all reviewers: listReviews failure falls back to requested reviewers only", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { requested_reviewers: [{ login: "reviewer1" }] },
        reviews: [{ user: { login: "reviewer2" } }],
      });
      github.failOn("listReviews", requestError(403));
      const git = createMockGit();
      const config = makeConfig({ copy_all_reviewers: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(["reviewer1"]);
      expect(core.setOutput).toHaveBeenCalledWith("was_successful", true);
    });

    it("add author as reviewer: requests PR author as reviewer on cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({ add_author_as_reviewer: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(["author"]);
    });

    it("add reviewers: requests configured reviewers on cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({ add_reviewers: ["alice", "bob"] });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(["alice", "bob"]);
    });

    it("add reviewers: deduplicates reviewers", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({ add_reviewers: ["alice", "alice"] });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.reviewersByPR.get(100)).toEqual(["alice"]);
    });

    it("add team reviewers: requests configured team reviewers on cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({
        add_team_reviewers: ["team-a", "team-b"],
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.teamReviewersByPR.get(100)).toEqual(["team-a", "team-b"]);
    });

    it("add team reviewers: deduplicates team reviewers", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({
        add_team_reviewers: ["team-a", "team-a"],
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.teamReviewersByPR.get(100)).toEqual(["team-a"]);
    });
  });

  describe("labels", () => {
    it("copy labels: copies matching labels", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: {
          labels: [{ name: "bug" }, { name: "enhancement" }],
        },
      });
      const git = createMockGit();
      const config = makeConfig({ copy_labels_pattern: /.*/ });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      const labels = github.labelsByPR.get(100);
      expect(labels).toContain("bug");
      expect(labels).toContain("enhancement");
    });

    it("add static labels: adds configured labels to cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({ add_labels: ["bug"] });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.labelsByPR.get(100)).toEqual(["bug"]);
    });
  });

  describe("milestone", () => {
    it("copy milestone: sets milestone on cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { milestone: { number: 5, id: 123, title: "v1.0" } },
      });
      const git = createMockGit();
      const config = makeConfig({ copy_milestone: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.milestonesByPR.get(100)).toBe(5);
    });
  });

  describe("merge commits", () => {
    it("merge_commits=fail: fails when merge commits are detected", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { commitShas: ["sha1", "sha2"] },
        mergeStrategyResult: MergeStrategy.MERGECOMMIT,
      });
      const git = createMockGit({
        findMergeCommits: vi.fn().mockResolvedValue(["sha1"]),
      });
      const config = makeConfig({
        commits: { cherry_picking: "auto", merge_commits: "fail" },
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(0);
      expect(github.comments).toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("contains merge commits"),
        }),
      );
    });

    it("merge_commits=skip: skips merge commits and cherry-picks the rest", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
        sourcePr: { commitShas: ["sha1", "sha2", "sha3"] },
        mergeStrategyResult: MergeStrategy.MERGECOMMIT,
      });
      const git = createMockGit({
        findMergeCommits: vi.fn().mockResolvedValue(["sha2"]),
      });
      const config = makeConfig({
        commits: { cherry_picking: "auto", merge_commits: "skip" },
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(git.cherryPick).toHaveBeenCalledWith(
        ["sha1", "sha3"],
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("auto-merge", () => {
    it("auto-merge enabled: enables auto-merge on cherry-pick PR", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.autoMergeByPR.get(100)).toBe("merge");
    });

    it("auto-merge with squash method: uses configured merge method", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig({
        auto_merge_enabled: true,
        auto_merge_method: "squash",
      });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.autoMergeByPR.get(100)).toBe("squash");
    });

    it("auto-merge failure: PR is still created, success is still reported", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      github.failOn(
        "enableAutoMerge",
        requestError(422, "auto-merge is not allowed"),
      );
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(github.createdPRs).toHaveLength(1);
      expect(github.autoMergeByPR.size).toBe(0);
      expect(core.setOutput).toHaveBeenCalledWith("was_successful", true);
    });

    it("auto-merge not allowed: warns about repository settings", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      github.failOn(
        "enableAutoMerge",
        requestError(422, "API Error", {
          message: "auto-merge is not allowed",
        }),
      );
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Allow auto-merge"),
      );
      warnSpy.mockRestore();
    });

    it("merge commits not allowed: suggests squash or rebase", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      github.failOn(
        "enableAutoMerge",
        requestError(422, "API Error", {
          message: "merge commits are not allowed",
        }),
      );
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("squash"));
      warnSpy.mockRestore();
    });

    it("insufficient permissions: warns about token permissions", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      github.failOn(
        "enableAutoMerge",
        requestError(403, "API Error", {
          message: "not authorized to enable auto-merge",
        }),
      );
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("permissions"),
      );
      warnSpy.mockRestore();
    });

    it("clean status: warns that auto-merge is not needed", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      github.failOn(
        "enableAutoMerge",
        requestError(422, "API Error", {
          message: "Pull request is in clean status",
        }),
      );
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("merged immediately"),
      );
      warnSpy.mockRestore();
    });

    it("protected branch: warns about branch protection", async () => {
      const warnSpy = vi.spyOn(console, "warn");
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      github.failOn(
        "enableAutoMerge",
        requestError(422, "API Error", {
          message: "protected branch rules prevent this",
        }),
      );
      const git = createMockGit();
      const config = makeConfig({ auto_merge_enabled: true });
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Branch protection"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("outputs", () => {
    it("outputs: sets was_successful, was_successful_by_target, created_pull_numbers", async () => {
      const github = new FakeGithub({
        commentBody: "/cherry-pick main",
      });
      const git = createMockGit();
      const config = makeConfig();
      const cherryPick = new CherryPick(github, config, git);
      await cherryPick.run();

      expect(core.setOutput).toHaveBeenCalledWith("was_successful", true);
      expect(core.setOutput).toHaveBeenCalledWith(
        "was_successful_by_target",
        expect.stringContaining("main=true"),
      );
      expect(core.setOutput).toHaveBeenCalledWith(
        "created_pull_numbers",
        "100",
      );
    });
  });
});
