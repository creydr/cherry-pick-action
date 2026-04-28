import type { Config } from "../../cherry-pick.js";

export function makeConfig(overrides?: Partial<Config>): Config {
  return {
    pwd: "/tmp",
    comment_pattern: new RegExp("^\\/cherry-pick (.+)$"),
    pull: {
      description: "Cherry-pick of #${pull_number}",
      title: "[Cherry-pick ${target_branch}] ${pull_title}",
      branch_name: "cherry-pick-${pull_number}-to-${target_branch}",
    },
    add_labels: [],
    add_reviewers: [],
    add_team_reviewers: [],
    commits: { cherry_picking: "auto", merge_commits: "fail" },
    copy_milestone: false,
    copy_assignees: false,
    copy_requested_reviewers: false,
    copy_all_reviewers: false,
    add_author_as_assignee: false,
    add_author_as_reviewer: false,
    auto_merge_enabled: false,
    auto_merge_method: "merge",
    experimental: { conflict_resolution: "fail" },
    ...overrides,
  };
}
