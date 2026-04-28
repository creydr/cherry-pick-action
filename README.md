# Cherry-Pick Action

Cherry-pick pull requests to other branches by commenting `/cherry-pick <target-branch>`.

## Usage

Add the following workflow to your repository (e.g. `.github/workflows/cherry-pick.yml`):

```yaml
name: Cherry-pick
on:
  pull_request_target:
    types: [closed]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write

jobs:
  cherry-pick:
    name: Cherry-pick
    runs-on: ubuntu-latest
    if: >
      (
        github.event_name == 'pull_request_target' &&
        github.event.pull_request.merged
      ) || (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(github.event.comment.body, '/cherry-pick')
      )
    steps:
      - uses: actions/checkout@v4
      - name: Cherry-pick pull request
        uses: creydr/cherry-pick-action@v1
```

Then, on any merged pull request, add a comment:

```
/cherry-pick release-1.0
```

The action will cherry-pick the PR's commits into a new branch and open a pull request targeting `release-1.0`.

### Multiple branches

Specify multiple target branches in a single command:

```
/cherry-pick release-1.0 release-1.1
```

Or use multiple commands in one comment:

```
/cherry-pick release-1.0
/cherry-pick release-2.0
```

### Trigger behavior

- **`issue_comment` (created):** When a `/cherry-pick` comment is posted on a merged PR, the action processes that comment immediately.
- **`pull_request_target` (closed/merged):** When a PR is merged, the action scans all existing comments for `/cherry-pick` commands and processes each unique target.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `github_token` | Token to authenticate requests to GitHub. Either `GITHUB_TOKEN` or a repo-scoped Personal Access Token (PAT). | `${{ github.token }}` |
| `github_workspace` | Working directory for the action. | `${{ github.workspace }}` |
| `comment_pattern` | Regex pattern to match cherry-pick commands. Must contain a capture group for the target branch(es). The captured group is split by whitespace. | `^\/cherry-pick (.+)$` |
| `cherry_picking` | Determines which commits are cherry-picked. `auto` detects the merge method (squash, rebase, merge commit). `pull_request_head` always uses the PR's commits. | `auto` |
| `merge_commits` | How to handle merge commits. `fail` aborts on merge commits. `skip` ignores them. | `fail` |

### Pull request options

| Input | Description | Default |
| --- | --- | --- |
| `pull_title` | Template for the cherry-pick PR title. | `[Cherry-pick ${target_branch}] ${pull_title}` |
| `pull_description` | Template for the cherry-pick PR body. | `# Description\nCherry-pick of #${pull_number} to \`${target_branch}\`.` |
| `branch_name` | Template for the cherry-pick branch name. | `cherry-pick-${pull_number}-to-${target_branch}` |

#### Template placeholders

The following placeholders can be used in `pull_title`, `pull_description`, and `branch_name`:

| Placeholder | Description |
| --- | --- |
| `${pull_number}` | Number of the original pull request |
| `${pull_title}` | Title of the original pull request |
| `${pull_author}` | Login of the original pull request author |
| `${pull_description}` | Body of the original pull request |
| `${target_branch}` | Target branch for the cherry-pick |
| `${issue_refs}` | Space-separated issue references mentioned in the original PR body |

### Labels

| Input | Description | Default |
| --- | --- | --- |
| `add_labels` | Comma-separated labels to add to the cherry-pick PR. | _(none)_ |
| `copy_labels_pattern` | Regex pattern to match labels to copy from the original PR. | _(none)_ |

### Assignees

| Input | Description | Default |
| --- | --- | --- |
| `copy_assignees` | Copy assignees from the original PR. | `false` |
| `add_author_as_assignee` | Set the original PR author as an assignee. | `false` |

### Reviewers

| Input | Description | Default |
| --- | --- | --- |
| `copy_requested_reviewers` | Copy requested reviewers from the original PR. | `false` |
| `copy_all_reviewers` | Copy all reviewers (requested + submitted) from the original PR. | `false` |
| `add_author_as_reviewer` | Request a review from the original PR author. | `false` |
| `add_reviewers` | Comma-separated list of reviewers to add. | _(none)_ |
| `add_team_reviewers` | Comma-separated list of team reviewers to add. | _(none)_ |

### Milestone

| Input | Description | Default |
| --- | --- | --- |
| `copy_milestone` | Copy the milestone from the original PR. | `false` |

### Auto-merge

| Input | Description | Default |
| --- | --- | --- |
| `auto_merge_enabled` | Enable auto-merge on the cherry-pick PR. | `false` |
| `auto_merge_method` | Merge method for auto-merge: `merge`, `squash`, or `rebase`. | `merge` |

### Git committer

| Input | Description | Default |
| --- | --- | --- |
| `git_committer_name` | Name of the committer for cherry-picked commits. | `github-actions[bot]` |
| `git_committer_email` | Email of the committer for cherry-picked commits. | `github-actions[bot]@users.noreply.github.com` |

### Advanced

| Input | Description | Default |
| --- | --- | --- |
| `source_pr_number` | Explicitly specify the PR number to cherry-pick. When not set, the action determines it from the event payload. | _(none)_ |
| `experimental` | JSON object for experimental features. See [Conflict resolution](#conflict-resolution). | `{"conflict_resolution": "fail"}` |

## Outputs

| Output | Description |
| --- | --- |
| `was_successful` | `true` if all cherry-picks succeeded, `false` otherwise. |
| `was_successful_by_target` | Per-target results in the format `target=true\|false`, one per line. |
| `created_pull_numbers` | Space-separated list of created PR numbers. |

## Conflict resolution

By default, the action fails when a cherry-pick encounters a conflict. To instead create a draft PR with the conflict committed, set:

```yaml
- uses: creydr/cherry-pick-action@v1
  with:
    experimental: '{"conflict_resolution": "draft_commit_conflicts"}'
```

When a conflict is committed, the action posts instructions on how to resolve it locally:

```bash
git fetch origin <branch>
git worktree add --checkout .worktree/<branch> <branch>
cd .worktree/<branch>
git reset --hard HEAD^
git cherry-pick -x <commits>
```

## License

This project is licensed under the [MIT License](LICENSE).

This project was inspired and is based on [backport-action](https://github.com/korthout/backport-action).
