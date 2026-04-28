import { describe, it, expect } from "vitest";
import { findTargetBranchesFromComments } from "../cherry-pick.js";

const default_pattern = /^\/cherry-pick (.+)$/;

describe("find target branches from comments", () => {
  describe("returns an empty list", () => {
    it("when there are no comments", () => {
      expect(
        findTargetBranchesFromComments([], default_pattern, "feature/one"),
      ).toEqual([]);
    });

    it("when none of the comments match the pattern", () => {
      expect(
        findTargetBranchesFromComments(
          ["some comment", "another comment", "not a cherry-pick"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual([]);
    });

    it("when the comment pattern does not have a capture group", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick main"],
          /^no capture group$/,
          "feature/one",
        ),
      ).toEqual([]);
    });

    it("when the only matching target is the headref", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick feature/one"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual([]);
    });
  });

  describe("returns selected branches", () => {
    it("when a comment matches the pattern and captures a target branch", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick release-1"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1"]);
    });

    it("when multiple comments match the pattern", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick release-1", "/cherry-pick another/target/branch"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1", "another/target/branch"]);
    });

    it("without duplicates", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick release-1", "/cherry-pick release-1"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1"]);
    });

    it("when several comments match the pattern the headref is excluded", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick feature/one", "/cherry-pick feature/two"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["feature/two"]);
    });

    it("when a comment contains the cherry-pick command among other lines", () => {
      expect(
        findTargetBranchesFromComments(
          ["Some text before\n/cherry-pick release-1\nSome text after"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1"]);
    });

    it("with a custom pattern", () => {
      const customPattern = /^\/backport (.+)$/;
      expect(
        findTargetBranchesFromComments(
          ["/backport release-1"],
          customPattern,
          "feature/one",
        ),
      ).toEqual(["release-1"]);
    });

    it("when a single comment specifies multiple target branches", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick release-1.0 release-1.1"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1.0", "release-1.1"]);
    });

    it("when a single comment specifies multiple targets with extra whitespace", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick   release-1.0   release-1.1  "],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1.0", "release-1.1"]);
    });

    it("when a comment has multiple cherry-pick lines with multiple targets each", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick release-1.0 release-1.1\n/cherry-pick release-2.0"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1.0", "release-1.1", "release-2.0"]);
    });

    it("deduplicates across multi-branch and multi-comment targets", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick release-1.0 release-1.1", "/cherry-pick release-1.0"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1.0", "release-1.1"]);
    });

    it("ignores branch names starting with '-' (flag injection protection)", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick --flag release-1.0"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1.0"]);
    });

    it("excludes headref from multi-branch targets", () => {
      expect(
        findTargetBranchesFromComments(
          ["/cherry-pick feature/one release-1.0"],
          default_pattern,
          "feature/one",
        ),
      ).toEqual(["release-1.0"]);
    });
  });
});
