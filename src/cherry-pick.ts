import * as core from "@actions/core";
import dedent from "dedent";

import {
  CreatePullRequestResponse,
  PullRequest,
  MergeStrategy,
  RequestError,
} from "./github.js";
import { GithubApi } from "./github.js";
import { GitApi, GitRefNotFoundError } from "./git.js";
import * as utils from "./utils.js";

type PRContent = {
  title: string;
  body: string;
};

export type Config = {
  pwd: string;
  comment_pattern: RegExp;
  source_pr_number?: number;
  pull: {
    description: string;
    title: string;
    branch_name: string;
  };
  copy_labels_pattern?: RegExp;
  add_labels: string[];
  commits: {
    cherry_picking: "auto" | "pull_request_head";
    merge_commits: "fail" | "skip";
  };
  copy_milestone: boolean;
  copy_assignees: boolean;
  copy_all_reviewers: boolean;
  copy_requested_reviewers: boolean;
  add_author_as_assignee: boolean;
  add_author_as_reviewer: boolean;
  add_reviewers: string[];
  add_team_reviewers: string[];
  auto_merge_enabled: boolean;
  auto_merge_method: "merge" | "squash" | "rebase";
  experimental: Experimental;
};

type Experimental = {
  conflict_resolution: "fail" | "draft_commit_conflicts";
};
const experimentalDefaults: Experimental = {
  conflict_resolution: `fail`,
};
export { experimentalDefaults };

enum Output {
  wasSuccessful = "was_successful",
  wasSuccessfulByTarget = "was_successful_by_target",
  created_pull_numbers = "created_pull_numbers",
}

export class CherryPick {
  private github;
  private config;
  private git;

  constructor(github: GithubApi, config: Config, git: GitApi) {
    this.github = github;
    this.config = config;
    this.git = git;
  }

  async run(): Promise<void> {
    try {
      const payload = this.github.getPayload();

      const owner = this.github.getRepo().owner;
      const repo = payload.repository?.name ?? this.github.getRepo().repo;

      const pull_number =
        this.config.source_pr_number === undefined
          ? this.github.getPullNumber()
          : this.config.source_pr_number;
      const mainpr = await this.github.getPullRequest(pull_number);

      if (!(await this.github.isMerged(mainpr))) {
        const message = "Only merged pull requests can be cherry-picked.";
        await this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      const target_branches = await this.findTargetBranches(
        mainpr,
        pull_number,
      );
      if (target_branches.length === 0) {
        console.log(
          `Nothing to cherry-pick: no comments match the cherry-pick pattern '${this.config.comment_pattern.source}'`,
        );
        return;
      }

      console.log(
        `Fetching commits from the pull request (depth: ${mainpr.commits + 1})`,
      );
      await this.git.fetch(
        `refs/pull/${pull_number}/head`,
        this.config.pwd,
        mainpr.commits + 1,
      );

      const commitShas = await this.github.getCommits(mainpr);

      let commitShasToCherryPick;

      if (this.config.commits.cherry_picking === "auto") {
        const merge_commit_sha = await this.github.getMergeCommitSha(mainpr);

        const strategy = await this.github.mergeStrategy(
          mainpr,
          merge_commit_sha,
        );

        if (merge_commit_sha === null) {
          console.log(
            "Merge commit SHA is null. Using commits from the Pull Request.",
          );
          commitShasToCherryPick = commitShas;
        } else if (strategy === MergeStrategy.SQUASHED) {
          await this.git.fetch(
            `+${merge_commit_sha}:refs/remotes/origin/${merge_commit_sha}`,
            this.config.pwd,
            2,
          );
          commitShasToCherryPick = [merge_commit_sha];
        } else if (strategy === MergeStrategy.REBASED) {
          await this.git.fetch(
            `+${merge_commit_sha}:refs/remotes/origin/${merge_commit_sha}`,
            this.config.pwd,
            mainpr.commits + 1,
          );
          const range = `${merge_commit_sha}~${mainpr.commits}..${merge_commit_sha}`;
          commitShasToCherryPick = await this.git.findCommitsInRange(
            range,
            this.config.pwd,
          );
        } else if (strategy === MergeStrategy.MERGECOMMIT) {
          commitShasToCherryPick = commitShas;
        } else {
          console.log(
            "Could not detect merge strategy. Using commits from the Pull Request.",
          );
          commitShasToCherryPick = commitShas;
        }
      } else {
        console.log(
          "Not detecting merge strategy. Using commits from the Pull Request.",
        );
        commitShasToCherryPick = commitShas;
      }
      console.log(`Found commits to cherry-pick: ${commitShasToCherryPick}`);

      console.log("Checking the merged pull request for merge commits");
      const mergeCommitShas = await this.git.findMergeCommits(
        commitShasToCherryPick,
        this.config.pwd,
      );
      console.log(
        `Encountered ${mergeCommitShas.length || "no"} merge commits`,
      );
      if (
        mergeCommitShas.length > 0 &&
        this.config.commits.merge_commits === "fail"
      ) {
        const message = dedent`Cherry-pick failed because this pull request contains merge commits. \
          You can either cherry-pick this pull request manually, or configure the action to skip merge commits.`;
        console.error(message);
        await this.github.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: message,
        });
        return;
      }

      if (
        mergeCommitShas.length > 0 &&
        this.config.commits.merge_commits === "skip"
      ) {
        console.log("Skipping merge commits: " + mergeCommitShas);
        const nonMergeCommitShas = commitShasToCherryPick.filter(
          (sha) => !mergeCommitShas.includes(sha),
        );
        commitShasToCherryPick = nonMergeCommitShas;
      }
      console.log(
        "Will cherry-pick the following commits: " + commitShasToCherryPick,
      );

      let labelsToCopy: string[] = [];
      if (typeof this.config.copy_labels_pattern !== "undefined") {
        let copyLabelsPattern: RegExp = this.config.copy_labels_pattern;
        labelsToCopy = mainpr.labels
          .map((label) => label.name)
          .filter((label) => label.match(copyLabelsPattern));
        console.log(
          `Will copy labels matching ${copyLabelsPattern}. Found matching labels: ${labelsToCopy}`,
        );
      }

      const successByTarget = new Map<string, boolean>();
      const createdPullRequestNumbers = new Array<number>();
      for (const target of target_branches) {
        console.log(`Cherry-picking to target branch '${target}...'`);

        try {
          await this.git.fetch(target, this.config.pwd, 1);
        } catch (error) {
          if (error instanceof GitRefNotFoundError) {
            const message = this.composeMessageForFetchTargetFailure(error.ref);
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          } else {
            throw error;
          }
        }

        try {
          const branchname = utils.replacePlaceholders(
            this.config.pull.branch_name,
            mainpr,
            target,
          );

          console.log(`Start cherry-pick to ${branchname}`);
          try {
            await this.git.checkout(
              branchname,
              `origin/${target}`,
              this.config.pwd,
            );
          } catch (error) {
            const message = this.composeMessageForCheckoutFailure(
              target,
              branchname,
              commitShasToCherryPick,
            );
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }

          let uncommittedShas: string[] | null;

          try {
            uncommittedShas = await this.git.cherryPick(
              commitShasToCherryPick,
              this.config.experimental.conflict_resolution,
              this.config.pwd,
            );
          } catch (error) {
            const message = this.composeMessageForCherryPickFailure(
              target,
              branchname,
              commitShasToCherryPick,
            );
            console.error(message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }

          console.info(`Push branch to origin`);
          const pushExitCode = await this.git.push(
            branchname,
            "origin",
            this.config.pwd,
          );
          if (pushExitCode != 0) {
            try {
              console.info(
                `Branch ${branchname} may already exist, fetching it instead to recover previous run`,
              );
              await this.git.fetch(branchname, this.config.pwd, 1);
              console.info(
                `Previous branch successfully recovered, retrying PR creation`,
              );
            } catch {
              const message = this.composeMessageForGitPushFailure(
                target,
                pushExitCode,
              );
              console.error(message);
              successByTarget.set(target, false);
              await this.github.createComment({
                owner,
                repo,
                issue_number: pull_number,
                body: message,
              });
              continue;
            }
          }

          console.info(`Create PR for ${branchname}`);
          const { title, body } = this.composePRContent(target, mainpr);
          let new_pr_response: CreatePullRequestResponse;
          try {
            new_pr_response = await this.github.createPR({
              owner,
              repo,
              title,
              body,
              head: branchname,
              base: target,
              maintainer_can_modify: true,
              draft: uncommittedShas !== null,
            });
          } catch (error) {
            if (!(error instanceof RequestError)) throw error;

            if (
              error.status === 422 &&
              (error.response?.data as any)?.errors?.some((err: any) =>
                err.message?.startsWith("A pull request already exists for "),
              )
            ) {
              console.info(`PR for ${branchname} already exists, skipping.`);
              successByTarget.set(target, true);
              continue;
            }

            console.error(JSON.stringify(error.response?.data));
            successByTarget.set(target, false);
            const message = this.composeMessageForCreatePRFailed(error);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: message,
            });
            continue;
          }
          const new_pr = new_pr_response.data;

          if (this.config.copy_milestone === true) {
            const milestone = mainpr.milestone?.number;
            if (milestone) {
              console.info("Setting milestone to " + milestone);
              try {
                await this.github.setMilestone(new_pr.number, milestone);
              } catch (error) {
                if (!(error instanceof RequestError)) throw error;
                console.error(JSON.stringify(error.response));
              }
            }
          }

          if (this.config.copy_assignees === true) {
            const assignees =
              mainpr.assignees?.map((assignee) => assignee.login) ?? [];
            if (assignees.length > 0) {
              console.info("Setting assignees " + assignees);
              try {
                await this.github.addAssignees(new_pr.number, assignees, {
                  owner,
                  repo,
                });
              } catch (error) {
                if (!(error instanceof RequestError)) throw error;
                console.error(JSON.stringify(error.response));
              }
            }
          }

          if (this.config.copy_all_reviewers == true) {
            const requestedReviewers =
              mainpr.requested_reviewers?.map((reviewer) => reviewer.login) ??
              [];

            let submittedReviewers: string[] = [];
            try {
              const { data: reviews } = await this.github.listReviews(
                owner,
                repo,
                mainpr.number,
              );

              submittedReviewers = [
                ...new Set(
                  reviews
                    .map((review) => review.user?.login)
                    .filter((login): login is string => Boolean(login)),
                ),
              ];
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;
              console.error(JSON.stringify(error.response));
            }

            const reviewers = [
              ...new Set([...requestedReviewers, ...submittedReviewers]),
            ];

            if (reviewers.length > 0) {
              console.info("Setting reviewers " + reviewers);
              const reviewRequest = {
                owner,
                repo,
                pull_number: new_pr.number,
                reviewers: reviewers,
              };
              try {
                await this.github.requestReviewers(reviewRequest);
              } catch (error) {
                if (!(error instanceof RequestError)) throw error;
                console.error(JSON.stringify(error.response));
              }
            }
          }

          if (this.config.copy_requested_reviewers == true) {
            const reviewers =
              mainpr.requested_reviewers?.map((reviewer) => reviewer.login) ??
              [];
            if (reviewers.length > 0) {
              console.info("Setting reviewers " + reviewers);
              const reviewRequest = {
                owner,
                repo,
                pull_number: new_pr.number,
                reviewers: reviewers,
              };
              try {
                await this.github.requestReviewers(reviewRequest);
              } catch (error) {
                if (!(error instanceof RequestError)) throw error;
                console.error(JSON.stringify(error.response));
              }
            }
          }

          const labels = [
            ...new Set([...labelsToCopy, ...this.config.add_labels]),
          ];
          if (labels.length > 0) {
            try {
              await this.github.labelPR(new_pr.number, labels, {
                owner,
                repo,
              });
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;
              console.error(JSON.stringify(error.response));
            }
          }

          if (this.config.add_author_as_assignee == true) {
            const author = mainpr.user.login;
            console.info("Setting " + author + " as assignee");
            try {
              await this.github.addAssignees(new_pr.number, [author], {
                owner,
                repo,
              });
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;
              console.error(JSON.stringify(error.response));
            }
          }

          if (this.config.add_author_as_reviewer == true) {
            const author = mainpr.user.login;
            console.info("Requesting review from " + author);
            try {
              await this.github.requestReviewers({
                owner,
                repo,
                pull_number: new_pr.number,
                reviewers: [author],
              });
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;
              console.error(JSON.stringify(error.response));
            }
          }

          const addedReviewers = [...new Set(this.config.add_reviewers)];
          if (addedReviewers.length > 0) {
            console.info("Adding reviewers: " + addedReviewers);
            try {
              await this.github.requestReviewers({
                owner,
                repo,
                pull_number: new_pr.number,
                reviewers: addedReviewers,
              });
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;
              console.error(JSON.stringify(error.response));
            }
          }

          const addedTeamReviewers = [
            ...new Set(this.config.add_team_reviewers),
          ];
          if (addedTeamReviewers.length > 0) {
            console.info("Adding team reviewers: " + addedTeamReviewers);
            try {
              await this.github.requestReviewers({
                owner,
                repo,
                pull_number: new_pr.number,
                reviewers: [],
                team_reviewers: addedTeamReviewers,
              });
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;
              console.error(JSON.stringify(error.response));
            }
          }

          if (this.config.auto_merge_enabled === true) {
            console.info(
              "Attempting to enable auto-merge for PR #" + new_pr.number,
            );
            try {
              await this.github.enableAutoMerge(
                new_pr.number,
                {
                  owner,
                  repo,
                },
                this.config.auto_merge_method,
              );
              console.info(
                "Successfully enabled auto-merge for PR #" + new_pr.number,
              );
            } catch (error) {
              if (!(error instanceof RequestError)) throw error;

              const errorMessage = this.getAutoMergeErrorMessage(
                error,
                this.config.auto_merge_method,
              );
              console.warn(
                `Failed to enable auto-merge for PR #${new_pr.number}: ${errorMessage}`,
              );
              console.warn(
                "The cherry-pick PR was created successfully, but auto-merge could not be enabled.",
              );
            }
          }

          const successMessage =
            uncommittedShas !== null
              ? this.composeMessageForSuccessWithConflicts(
                  new_pr.number,
                  target,
                  branchname,
                  uncommittedShas,
                  this.config.experimental.conflict_resolution,
                )
              : this.composeMessageForSuccess(new_pr.number, target);

          successByTarget.set(target, true);
          createdPullRequestNumbers.push(new_pr.number);
          await this.github.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: successMessage,
          });

          if (uncommittedShas !== null) {
            const conflictMessage: string =
              this.composeMessageToResolveCommittedConflicts(
                target,
                branchname,
                uncommittedShas,
                this.config.experimental.conflict_resolution,
              );

            await this.github.createComment({
              owner,
              repo,
              issue_number: new_pr.number,
              body: conflictMessage,
            });
          }
        } catch (error) {
          if (error instanceof Error) {
            console.error(error.message);
            successByTarget.set(target, false);
            await this.github.createComment({
              owner,
              repo,
              issue_number: pull_number,
              body: error.message,
            });
          } else {
            throw error;
          }
        }
      }

      this.createOutput(successByTarget, createdPullRequestNumbers);
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
        core.setFailed(error.message);
      } else {
        console.error(`An unexpected error occurred: ${JSON.stringify(error)}`);
        core.setFailed(
          "An unexpected error occured. Please check the logs for details",
        );
      }
    }
  }

  private async findTargetBranches(
    mainpr: PullRequest,
    pull_number: number,
  ): Promise<string[]> {
    const commentBody = this.github.getCommentBody();
    let commentBodies: string[];

    if (commentBody !== undefined) {
      // issue_comment event: use only the triggering comment
      commentBodies = [commentBody];
    } else {
      // pull_request_target event: scan all comments
      commentBodies = await this.github.getComments(pull_number);
    }

    return findTargetBranchesFromComments(
      commentBodies,
      this.config.comment_pattern,
      mainpr.head.ref,
    );
  }

  private composePRContent(target: string, main: PullRequest): PRContent {
    const title = utils.replacePlaceholders(
      this.config.pull.title,
      main,
      target,
    );
    const body = utils.replacePlaceholders(
      this.config.pull.description,
      main,
      target,
    );
    return { title, body };
  }

  private composeMessageForFetchTargetFailure(target: string) {
    return dedent`Cherry-pick failed for \`${target}\`: couldn't find remote ref \`${target}\`.
                  Please ensure that this Github repo has a branch named \`${target}\`.`;
  }

  private composeMessageForCheckoutFailure(
    target: string,
    branchname: string,
    commitShasToCherryPick: string[],
  ): string {
    const reason = "because it was unable to create a new branch";
    const suggestion = this.composeSuggestion(
      target,
      branchname,
      commitShasToCherryPick,
      false,
    );
    return dedent`Cherry-pick failed for \`${target}\`, ${reason}.

                  Please cherry-pick the changes locally.
                  ${suggestion}`;
  }

  private composeMessageForCherryPickFailure(
    target: string,
    branchname: string,
    commitShasToCherryPick: string[],
  ): string {
    const reason = "because it was unable to cherry-pick the commit(s)";

    const suggestion = this.composeSuggestion(
      target,
      branchname,
      commitShasToCherryPick,
      false,
      "fail",
    );

    return dedent`Cherry-pick failed for \`${target}\`, ${reason}.

                  Please cherry-pick the changes locally and resolve any conflicts.
                  ${suggestion}`;
  }

  private composeMessageToResolveCommittedConflicts(
    target: string,
    branchname: string,
    commitShasToCherryPick: string[],
    conflictResolution: string,
  ): string {
    const suggestion = this.composeSuggestion(
      target,
      branchname,
      commitShasToCherryPick,
      true,
      conflictResolution,
    );

    return dedent`Please cherry-pick the changes locally and resolve any conflicts.
                  ${suggestion}`;
  }

  private composeSuggestion(
    target: string,
    branchname: string,
    commitShasToCherryPick: string[],
    branchExist: boolean,
    conflictResolution: string = "fail",
  ) {
    if (branchExist) {
      if (conflictResolution === "draft_commit_conflicts") {
        return dedent`\`\`\`bash
        git fetch origin ${branchname}
        git worktree add --checkout .worktree/${branchname} ${branchname}
        cd .worktree/${branchname}
        git reset --hard HEAD^
        git cherry-pick -x ${commitShasToCherryPick.join(" ")}
        \`\`\``;
      } else {
        return "";
      }
    } else {
      return dedent`\`\`\`bash
      git fetch origin ${target}
      git worktree add -d .worktree/${branchname} origin/${target}
      cd .worktree/${branchname}
      git switch --create ${branchname}
      git cherry-pick -x ${commitShasToCherryPick.join(" ")}
      \`\`\``;
    }
  }

  private composeMessageForGitPushFailure(
    target: string,
    exitcode: number,
  ): string {
    return dedent`Git push to origin failed for ${target} with exitcode ${exitcode}`;
  }

  private composeMessageForCreatePRFailed(error: RequestError): string {
    return dedent`Cherry-pick branch created but failed to create PR.
                Request to create PR rejected with status ${error.status}.

                (see action log for full response)`;
  }

  private composeMessageForSuccess(pr_number: number, target: string) {
    return dedent`Successfully created cherry-pick PR for \`${target}\`:
                  - #${pr_number}`;
  }

  private composeMessageForSuccessWithConflicts(
    pr_number: number,
    target: string,
    branchname: string,
    commitShasToCherryPick: string[],
    conflictResolution: string,
  ): string {
    const suggestionToResolve = this.composeMessageToResolveCommittedConflicts(
      target,
      branchname,
      commitShasToCherryPick,
      conflictResolution,
    );
    return dedent`Created cherry-pick PR for \`${target}\`:
                  - #${pr_number} with remaining conflicts!

                  ${suggestionToResolve}`;
  }

  private createOutput(
    successByTarget: Map<string, boolean>,
    createdPullRequestNumbers: Array<number>,
  ) {
    const anyTargetFailed = Array.from(successByTarget.values()).includes(
      false,
    );
    core.setOutput(Output.wasSuccessful, !anyTargetFailed);

    const byTargetOutput = Array.from(successByTarget.entries()).reduce<string>(
      (i, [target, result]) => `${i}${target}=${result}\n`,
      "",
    );
    core.setOutput(Output.wasSuccessfulByTarget, byTargetOutput);

    const createdPullNumbersOutput = createdPullRequestNumbers.join(" ");
    core.setOutput(Output.created_pull_numbers, createdPullNumbersOutput);
  }

  private getAutoMergeErrorMessage(
    error: RequestError,
    mergeMethod: string,
  ): string {
    const errorStr = JSON.stringify(error.response?.data) || error.message;

    if (errorStr.includes("auto-merge") && errorStr.includes("not allowed")) {
      return `Repository does not have "Allow auto-merge" enabled. Please enable it in repository Settings > General > Pull Requests.`;
    }

    if (
      errorStr.includes("merge commits are not allowed") ||
      errorStr.includes("Merge method merge commits are not allowed")
    ) {
      return `Repository does not allow merge commits. Try using 'auto_merge_method: squash' or 'auto_merge_method: rebase' instead.`;
    }

    if (errorStr.includes("squash") && errorStr.includes("not allowed")) {
      return `Repository does not allow squash merging. Try using 'auto_merge_method: merge' or 'auto_merge_method: rebase' instead.`;
    }

    if (errorStr.includes("rebase") && errorStr.includes("not allowed")) {
      return `Repository does not allow rebase merging. Try using 'auto_merge_method: merge' or 'auto_merge_method: squash' instead.`;
    }

    if (
      errorStr.includes("not authorized") ||
      errorStr.includes("insufficient permissions")
    ) {
      return `Insufficient permissions to enable auto-merge. Ensure the GitHub token has 'contents: write' and 'pull-requests: write' permissions.`;
    }

    if (errorStr.includes("protected branch")) {
      return `Branch protection rules prevent auto-merge. Check if the bot/user has merge permissions on protected branches.`;
    }

    if (
      errorStr.includes("Pull request is in clean status") ||
      errorStr.includes("clean status")
    ) {
      return `PR can be merged immediately, so auto-merge is not needed. Auto-merge only works when there are pending requirements (like required status checks or reviews).`;
    }

    return `Auto-merge method '${mergeMethod}' failed. Check repository merge settings and permissions. Error: ${error.message}`;
  }
}

export function findTargetBranchesFromComments(
  commentBodies: string[],
  pattern: RegExp,
  headref: string,
): string[] {
  console.log("Determining target branches from comments...");

  const targets: string[] = [];
  for (const body of commentBodies) {
    for (const line of body.split("\n")) {
      const match = pattern.exec(line.trim());
      if (match && match.length >= 2) {
        const branches = match[1]
          .split(/\s+/)
          .map((b) => b.trim())
          .filter((b) => b !== "");
        for (const branch of branches) {
          if (branch.startsWith("-")) {
            console.warn(
              `Ignoring invalid branch name '${branch}': branch names starting with '-' are not allowed`,
            );
            continue;
          }
          targets.push(branch);
        }
      }
    }
  }

  const uniqueTargets = [...new Set(targets)].filter((t) => t !== headref);

  console.log(`Found target branches in comments: ${uniqueTargets}`);

  return uniqueTargets;
}
