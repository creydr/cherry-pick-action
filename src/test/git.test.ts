import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@actions/exec", () => ({
  getExecOutput: vi.fn(),
}));

import { getExecOutput } from "@actions/exec";
import { Git, GitRefNotFoundError } from "../git.js";

function mockExec(exitCode: number, stdout = "", stderr = "") {
  vi.mocked(getExecOutput).mockResolvedValueOnce({ exitCode, stdout, stderr });
}

describe("Git", () => {
  const git = new Git("Test User", "test@example.com", true);
  const pwd = "/tmp/workspace";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetch", () => {
    it("succeeds on exit code 0", async () => {
      mockExec(0);
      await expect(
        git.fetch("refs/heads/main", pwd, 1),
      ).resolves.toBeUndefined();
      expect(getExecOutput).toHaveBeenCalledWith(
        "git",
        ["fetch", "--depth=1", "origin", "refs/heads/main"],
        expect.anything(),
      );
    });

    it("throws GitRefNotFoundError on exit code 128", async () => {
      mockExec(128);
      await expect(git.fetch("refs/heads/missing", pwd, 1)).rejects.toThrow(
        GitRefNotFoundError,
      );
    });

    it("throws Error on other non-zero exit codes", async () => {
      mockExec(1);
      await expect(git.fetch("refs/heads/main", pwd, 1)).rejects.toThrow(
        "failed with exit code 1",
      );
    });

    it("uses custom remote", async () => {
      mockExec(0);
      await git.fetch("refs/heads/main", pwd, 1, "upstream");
      expect(getExecOutput).toHaveBeenCalledWith(
        "git",
        ["fetch", "--depth=1", "upstream", "refs/heads/main"],
        expect.anything(),
      );
    });
  });

  describe("findCommitsInRange", () => {
    it("parses multi-line output into SHA array", async () => {
      mockExec(0, '"sha1"\n"sha2"\n"sha3"');
      const result = await git.findCommitsInRange("HEAD~3..HEAD", pwd);
      expect(result).toEqual(["sha1", "sha2", "sha3"]);
    });

    it("handles trailing newline", async () => {
      mockExec(0, '"sha1"\n');
      const result = await git.findCommitsInRange("HEAD~1..HEAD", pwd);
      expect(result).toEqual(["sha1"]);
    });

    it("throws on non-zero exit code", async () => {
      mockExec(1);
      await expect(git.findCommitsInRange("HEAD~1..HEAD", pwd)).rejects.toThrow(
        "failed with exit code 1",
      );
    });
  });

  describe("findMergeCommits", () => {
    it("returns merge commit SHAs", async () => {
      mockExec(0, "merge-sha1\nmerge-sha2\n");
      const result = await git.findMergeCommits(["sha1", "sha2", "sha3"], pwd);
      expect(result).toEqual(["merge-sha1", "merge-sha2"]);
    });

    it("returns empty array for empty input without calling exec", async () => {
      const result = await git.findMergeCommits([], pwd);
      expect(result).toEqual([]);
      expect(getExecOutput).not.toHaveBeenCalled();
    });

    it("throws on non-zero exit code", async () => {
      mockExec(1);
      await expect(git.findMergeCommits(["sha1"], pwd)).rejects.toThrow(
        "failed with exit code 1",
      );
    });
  });

  describe("push", () => {
    it("returns exit code 0 on success", async () => {
      mockExec(0);
      const result = await git.push("my-branch", "origin", pwd);
      expect(result).toBe(0);
    });

    it("returns non-zero exit code on failure without throwing", async () => {
      mockExec(1);
      const result = await git.push("my-branch", "origin", pwd);
      expect(result).toBe(1);
    });
  });

  describe("checkout", () => {
    it("succeeds on exit code 0", async () => {
      mockExec(0);
      await expect(
        git.checkout("new-branch", "origin/main", pwd),
      ).resolves.toBeUndefined();
      expect(getExecOutput).toHaveBeenCalledWith(
        "git",
        ["switch", "-c", "new-branch", "origin/main"],
        expect.anything(),
      );
    });

    it("throws on non-zero exit code", async () => {
      mockExec(1);
      await expect(
        git.checkout("new-branch", "origin/main", pwd),
      ).rejects.toThrow("failed with exit code 1");
    });
  });

  describe("cherryPick", () => {
    describe("fail mode", () => {
      it("returns null on success", async () => {
        mockExec(0);
        const result = await git.cherryPick(["sha1", "sha2"], "fail", pwd);
        expect(result).toBeNull();
      });

      it("aborts and throws on failure", async () => {
        mockExec(1); // cherry-pick fails
        mockExec(0); // abort succeeds
        await expect(
          git.cherryPick(["sha1", "sha2"], "fail", pwd),
        ).rejects.toThrow("failed with exit code 1");
        expect(getExecOutput).toHaveBeenCalledWith(
          "git",
          ["cherry-pick", "--abort"],
          expect.anything(),
        );
      });
    });

    describe("draft_commit_conflicts mode", () => {
      it("returns null when all commits apply cleanly", async () => {
        mockExec(0); // sha1
        mockExec(0); // sha2
        mockExec(0); // sha3
        const result = await git.cherryPick(
          ["sha1", "sha2", "sha3"],
          "draft_commit_conflicts",
          pwd,
        );
        expect(result).toBeNull();
      });

      it("commits conflicts and returns remaining SHAs on conflict", async () => {
        mockExec(1); // sha1 conflicts (exit code 1)
        mockExec(0); // commit succeeds
        const result = await git.cherryPick(
          ["sha1", "sha2", "sha3"],
          "draft_commit_conflicts",
          pwd,
        );
        expect(result).toEqual(["sha1", "sha2", "sha3"]);
      });

      it("aborts and throws on non-conflict error", async () => {
        mockExec(2); // sha1 fails with non-conflict exit code
        mockExec(0); // abort succeeds
        await expect(
          git.cherryPick(["sha1", "sha2"], "draft_commit_conflicts", pwd),
        ).rejects.toThrow("failed with exit code 2");
      });

      it("aborts and throws when conflict commit fails", async () => {
        mockExec(1); // sha1 conflicts
        mockExec(1); // commit fails
        mockExec(0); // abort succeeds
        await expect(
          git.cherryPick(["sha1", "sha2"], "draft_commit_conflicts", pwd),
        ).rejects.toThrow("failed with exit code 1");
      });
    });

    describe("unsupported mode", () => {
      it("throws for unknown conflict_resolution value", async () => {
        mockExec(1); // cherry-pick fails, triggering conflict resolution check
        await expect(
          git.cherryPick(["sha1"], "unknown_mode", pwd),
        ).rejects.toThrow("Unsupported conflict_resolution method");
      });
    });
  });

  describe("environment variables", () => {
    it("passes GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL", async () => {
      mockExec(0);
      await git.fetch("refs/heads/main", pwd, 1);
      expect(getExecOutput).toHaveBeenCalledWith(
        "git",
        expect.anything(),
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_COMMITTER_NAME: "Test User",
            GIT_COMMITTER_EMAIL: "test@example.com",
          }),
        }),
      );
    });
  });
});
