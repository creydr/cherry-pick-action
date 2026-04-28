import * as core from "@actions/core";
import { CherryPick, Config, experimentalDefaults } from "./cherry-pick.js";
import { Github } from "./github.js";
import { Git } from "./git.js";

async function run(): Promise<void> {
  const token = core.getInput("github_token", { required: true });
  const pwd = core.getInput("github_workspace", { required: true });
  const gitCommitterName = core.getInput("git_committer_name");
  const gitCommitterEmail = core.getInput("git_committer_email");
  const comment_pattern = core.getInput("comment_pattern");
  const description = core.getInput("pull_description");
  const title = core.getInput("pull_title");
  const branch_name = core.getInput("branch_name");
  const add_labels = core.getInput("add_labels");
  const copy_labels_pattern = core.getInput("copy_labels_pattern");
  const cherry_picking = core.getInput("cherry_picking");
  const merge_commits = core.getInput("merge_commits");
  const copy_assignees = core.getInput("copy_assignees");
  const copy_milestone = core.getInput("copy_milestone");
  const copy_all_reviewers = core.getInput("copy_all_reviewers");
  const copy_requested_reviewers = core.getInput("copy_requested_reviewers");
  const add_author_as_assignee = core.getInput("add_author_as_assignee");
  const add_author_as_reviewer = core.getInput("add_author_as_reviewer");
  const add_reviewers = core.getInput("add_reviewers");
  const add_team_reviewers = core.getInput("add_team_reviewers");
  const auto_merge_enabled = core.getInput("auto_merge_enabled");
  const auto_merge_method = core.getInput("auto_merge_method");
  const source_pr_number = core.getInput("source_pr_number");

  let experimental: Record<string, string>;
  try {
    experimental = JSON.parse(core.getInput("experimental"));
  } catch {
    const message =
      "Invalid JSON in input 'experimental'. Please provide a valid JSON object.";
    console.error(message);
    core.setFailed(message);
    return;
  }

  if (cherry_picking !== "auto" && cherry_picking !== "pull_request_head") {
    const message = `Expected input 'cherry_picking' to be either 'auto' or 'pull_request_head', but was '${cherry_picking}'`;
    console.error(message);
    core.setFailed(message);
    return;
  }

  if (merge_commits !== "fail" && merge_commits !== "skip") {
    const message = `Expected input 'merge_commits' to be either 'fail' or 'skip', but was '${merge_commits}'`;
    console.error(message);
    core.setFailed(message);
    return;
  }

  if (
    auto_merge_method !== "merge" &&
    auto_merge_method !== "squash" &&
    auto_merge_method !== "rebase"
  ) {
    const message = `Expected input 'auto_merge_method' to be either 'merge', 'squash', or 'rebase', but was '${auto_merge_method}'`;
    console.error(message);
    core.setFailed(message);
    return;
  }

  if (
    copy_requested_reviewers === "true" &&
    add_author_as_reviewer === "true"
  ) {
    const message =
      "Expected only one of 'copy_requested_reviewers' and 'add_author_as_reviewer' to be enabled, but both were";
    console.error(message);
    core.setFailed(message);
    return;
  }

  for (const key in experimental) {
    if (!(key in experimentalDefaults)) {
      console.warn(
        `Encountered unexpected key in input 'experimental'. No experimental config options known for key '${key}'. Please check the documentation for details about experimental features.`,
      );
    }

    if (key === "conflict_resolution") {
      if (
        experimental[key] !== "fail" &&
        experimental[key] !== "draft_commit_conflicts"
      ) {
        const message = `Expected input 'conflict_resolution' to be either 'fail' or 'draft_commit_conflicts', but was '${experimental[key]}'`;
        console.error(message);
        core.setFailed(message);
        return;
      }
    }
  }

  let parsedSourcePrNumber: number | undefined;
  if (source_pr_number !== "") {
    parsedSourcePrNumber = Number(source_pr_number);
    if (!Number.isInteger(parsedSourcePrNumber) || parsedSourcePrNumber <= 0) {
      const message = `Expected input 'source_pr_number' to be a positive integer, but was '${source_pr_number}'`;
      console.error(message);
      core.setFailed(message);
      return;
    }
  }

  let parsedCommentPattern: RegExp;
  try {
    parsedCommentPattern =
      comment_pattern === ""
        ? new RegExp("^\\/cherry-pick (.+)$")
        : new RegExp(comment_pattern);
  } catch {
    const message = `Invalid regex in input 'comment_pattern': '${comment_pattern}'`;
    console.error(message);
    core.setFailed(message);
    return;
  }

  let parsedCopyLabelsPattern: RegExp | undefined;
  try {
    parsedCopyLabelsPattern =
      copy_labels_pattern === "" ? undefined : new RegExp(copy_labels_pattern);
  } catch {
    const message = `Invalid regex in input 'copy_labels_pattern': '${copy_labels_pattern}'`;
    console.error(message);
    core.setFailed(message);
    return;
  }

  const github = new Github(token);
  const git = new Git(gitCommitterName, gitCommitterEmail);
  const config: Config = {
    pwd,
    comment_pattern: parsedCommentPattern,
    pull: { description, title, branch_name },
    copy_labels_pattern: parsedCopyLabelsPattern,
    add_labels:
      add_labels === ""
        ? []
        : add_labels
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean),
    commits: { cherry_picking, merge_commits },
    copy_assignees: copy_assignees === "true",
    copy_milestone: copy_milestone === "true",
    copy_all_reviewers: copy_all_reviewers === "true",
    copy_requested_reviewers: copy_requested_reviewers === "true",
    add_author_as_assignee: add_author_as_assignee === "true",
    add_author_as_reviewer: add_author_as_reviewer === "true",
    add_reviewers:
      add_reviewers === ""
        ? []
        : add_reviewers
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
    add_team_reviewers:
      add_team_reviewers === ""
        ? []
        : add_team_reviewers
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
    auto_merge_enabled: auto_merge_enabled === "true",
    auto_merge_method: auto_merge_method as "merge" | "squash" | "rebase",
    experimental: {
      conflict_resolution:
        (experimental.conflict_resolution as
          | "fail"
          | "draft_commit_conflicts") ??
        experimentalDefaults.conflict_resolution,
    },
    source_pr_number: parsedSourcePrNumber,
  };
  const cherryPick = new CherryPick(github, config, git);

  return cherryPick.run();
}

run();
