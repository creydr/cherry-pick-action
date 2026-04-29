import * as github from "@actions/github";
export { RequestError } from "@octokit/request-error";

export interface GithubApi {
  getRepo(): Repo;
  getPayload(): Payload;
  getPullNumber(): number;
  getCommentBody(): string | undefined;
  createComment(comment: Comment): Promise<{}>;
  getComments(issue_number: number): Promise<string[]>;
  getPullRequest(pull_number: number): Promise<PullRequest>;
  isMerged(pull: PullRequest): Promise<boolean>;
  getCommits(pull: PullRequest): Promise<string[]>;
  createPR(pr: CreatePullRequest): Promise<CreatePullRequestResponse>;
  labelPR(
    pr: number,
    labels: string[],
    repo: Repo,
  ): Promise<LabelPullRequestResponse>;
  listReviews(
    owner: string,
    repo: string,
    pull_number: number,
  ): Promise<ListReviewsResponse>;
  requestReviewers(request: ReviewRequest): Promise<RequestReviewersResponse>;
  addAssignees(
    pr: number,
    assignees: string[],
    repo: Repo,
  ): Promise<GenericResponse>;
  setMilestone(pr: number, milestone: number): Promise<GenericResponse>;
  enableAutoMerge(
    pr: number,
    repo: Repo,
    mergeMethod: "merge" | "squash" | "rebase",
  ): Promise<GenericResponse>;
  mergeStrategy(
    pull: PullRequest,
    merge_commit_sha: string | null,
  ): Promise<MergeStrategy>;
  getMergeCommitSha(pull: PullRequest): Promise<string | null>;
}

export class Github implements GithubApi {
  #octokit;
  #context;

  constructor(token: string) {
    this.#octokit = github.getOctokit(token);
    this.#context = github.context;
  }

  public getRepo() {
    return this.#context.repo;
  }

  public getPayload() {
    return this.#context.payload;
  }

  public getPullNumber() {
    if (this.#context.payload.pull_request) {
      return this.#context.payload.pull_request.number;
    }
    return this.#context.issue.number;
  }

  public getCommentBody(): string | undefined {
    return this.#context.payload.comment?.body;
  }

  public async createComment(comment: Comment) {
    console.log(`Create comment: ${comment.body}`);
    return this.#octokit.rest.issues.createComment(comment);
  }

  public async getComments(issue_number: number): Promise<string[]> {
    console.log(`Retrieve comments for issue #${issue_number}`);
    const comments: string[] = [];

    for (let page = 1; ; page++) {
      const response = await this.#octokit.rest.issues.listComments({
        ...this.getRepo(),
        issue_number,
        per_page: 100,
        page,
      });
      for (const comment of response.data) {
        if (comment.body) {
          comments.push(comment.body);
        }
      }
      if (response.data.length < 100) break;
    }

    return comments;
  }

  public async getPullRequest(pull_number: number) {
    console.log(`Retrieve pull request data for #${pull_number}`);
    return this.#octokit.rest.pulls
      .get({
        ...this.getRepo(),
        pull_number,
      })
      .then((response: { data: PullRequest }) => response.data);
  }

  public async isMerged(pull: PullRequest) {
    console.log(`Check whether pull request ${pull.number} is merged`);
    return this.#octokit.rest.pulls
      .checkIfMerged({ ...this.getRepo(), pull_number: pull.number })
      .then(() => true)
      .catch((error: { status?: number }) => {
        if (error?.status === 404) return false;
        else throw error;
      });
  }

  public async getCommits(pull: PullRequest) {
    console.log(`Retrieving the commits from pull request ${pull.number}`);

    const commits: string[] = [];

    const getCommitsPaged = (page: number) =>
      this.#octokit.rest.pulls
        .listCommits({
          ...this.getRepo(),
          pull_number: pull.number,
          per_page: 100,
          page: page,
        })
        .then((response: { data: { sha: string }[] }) =>
          response.data.map((commit) => commit.sha),
        );

    for (let page = 1; page <= Math.ceil(pull.commits / 100); page++) {
      const commitsOnPage = await getCommitsPaged(page);
      commits.push(...commitsOnPage);
    }

    return commits;
  }

  public async createPR(pr: CreatePullRequest) {
    console.log(`Create PR: ${pr.body}`);
    return this.#octokit.rest.pulls.create(pr);
  }

  public async listReviews(owner: string, repo: string, pull_number: number) {
    console.log(`Retrieving reviews from pull request: ${pull_number}`);
    return this.#octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number,
    });
  }

  public async requestReviewers(request: ReviewRequest) {
    console.log(`Request reviewers: ${request.reviewers}`);
    return this.#octokit.rest.pulls.requestReviewers(request);
  }

  public async labelPR(pr: number, labels: string[], repo: Repo) {
    console.log(`Label PR #${pr} with labels: ${labels}`);
    return this.#octokit.rest.issues.addLabels({
      ...repo,
      issue_number: pr,
      labels,
    });
  }

  public async addAssignees(pr: number, assignees: string[], repo: Repo) {
    console.log(`Set Assignees ${assignees} to #${pr}`);
    return this.#octokit.rest.issues.addAssignees({
      ...repo,
      issue_number: pr,
      assignees,
    });
  }

  public async setMilestone(pr: number, milestone: number) {
    console.log(`Set Milestone ${milestone} to #${pr}`);
    return this.#octokit.rest.issues.update({
      ...this.getRepo(),
      issue_number: pr,
      milestone: milestone,
    });
  }

  public async enableAutoMerge(
    pr: number,
    repo: Repo,
    mergeMethod: "merge" | "squash" | "rebase",
  ): Promise<GenericResponse> {
    console.log(`Enable auto-merge for PR #${pr} with method: ${mergeMethod}`);

    const mergeMethodMap = {
      merge: "MERGE",
      squash: "SQUASH",
      rebase: "REBASE",
    } as const;
    const graphqlMergeMethod = mergeMethodMap[mergeMethod] ?? "MERGE";

    const query = `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            id
          }
        }
      }
    `;

    const { repository } = (await this.#octokit.graphql(query, {
      owner: repo.owner,
      repo: repo.repo,
      number: pr,
    })) as any;

    const pullRequestId = repository.pullRequest.id;

    const mutation = `
      mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod) {
        enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod}) {
          pullRequest {
            autoMergeRequest {
              enabledAt
              mergeMethod
            }
          }
        }
      }
    `;

    await this.#octokit.graphql(mutation, {
      pullRequestId,
      mergeMethod: graphqlMergeMethod,
    });

    return { status: 200 };
  }

  public async getMergeCommitSha(pull: PullRequest) {
    return pull.merge_commit_sha;
  }

  private async getCommit(sha: string) {
    return this.#octokit.rest.repos.getCommit({
      ...this.getRepo(),
      ref: sha,
    });
  }

  private async getParents(sha: string) {
    const commit = await this.getCommit(sha);
    return commit.data.parents;
  }

  private async getPullRequestsAssociatedWithCommit(sha: string) {
    return this.#octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...this.getRepo(),
      commit_sha: sha,
    });
  }

  private async isShaAssociatedWithPullRequest(sha: string, pull: PullRequest) {
    const assoc_pr = await this.getPullRequestsAssociatedWithCommit(sha);
    return assoc_pr.data.some(
      (pr: { number: number }) => pr.number === pull.number,
    );
  }

  private isMergeCommit(parents: { sha: string }[]): boolean {
    return parents.length > 1;
  }

  private isRebased(
    first_parent_belongs_to_pr: boolean,
    merge_belongs_to_pr: boolean,
  ): boolean {
    return first_parent_belongs_to_pr && merge_belongs_to_pr;
  }

  private isSquashed(
    first_parent_belongs_to_pr: boolean,
    merge_belongs_to_pr: boolean,
  ): boolean {
    return !first_parent_belongs_to_pr && merge_belongs_to_pr;
  }

  public async mergeStrategy(
    pull: PullRequest,
    merge_commit_sha: string | null,
  ): Promise<MergeStrategy> {
    if (merge_commit_sha === null) {
      console.log(
        "PR was merged without merge_commit_sha unable to detect merge method",
      );
      return MergeStrategy.UNKNOWN;
    }

    const parents = await this.getParents(merge_commit_sha);

    if (this.isMergeCommit(parents)) {
      console.log("PR was merged using a merge commit");
      return MergeStrategy.MERGECOMMIT;
    }

    if (pull.commits === 1) {
      console.log(
        "PR was merged using a squash or a rebase. Choosing squash strategy.",
      );
      return MergeStrategy.SQUASHED;
    }

    const first_parent_sha = parents[0].sha;
    const first_parent_belongs_to_pr =
      await this.isShaAssociatedWithPullRequest(first_parent_sha, pull);
    const merge_belongs_to_pr = await this.isShaAssociatedWithPullRequest(
      merge_commit_sha,
      pull,
    );

    if (this.isRebased(first_parent_belongs_to_pr, merge_belongs_to_pr)) {
      console.log("PR was merged using a rebase");
      return MergeStrategy.REBASED;
    }

    if (this.isSquashed(first_parent_belongs_to_pr, merge_belongs_to_pr)) {
      console.log("PR was merged using a squash");
      return MergeStrategy.SQUASHED;
    }

    return MergeStrategy.UNKNOWN;
  }
}

export enum MergeStrategy {
  SQUASHED = "squashed",
  REBASED = "rebased",
  MERGECOMMIT = "mergecommit",
  UNKNOWN = "unknown",
}

export type Repo = {
  owner: string;
  repo: string;
};

export type PullRequest = {
  number: number;
  title: string;
  body: string | null;
  merge_commit_sha: string | null;
  head: {
    sha: string;
    ref: string;
  };
  base: {
    sha: string;
  };
  user: {
    login: string;
  };
  labels: {
    name: string;
  }[];
  requested_reviewers?:
    | {
        login: string;
      }[]
    | null;
  commits: number;
  milestone: {
    number: number;
    id: number;
    title: string;
  } | null;
  assignees?:
    | {
        login: string;
        id: number;
      }[]
    | null;
  merged_by: {
    login: string;
  } | null;
};
export type CreatePullRequestResponse = {
  status: number;
  data: {
    number: number;
    requested_reviewers?: ({ login: string } | null)[] | null;
  };
};
export type RequestReviewersResponse = CreatePullRequestResponse;

export type PullRequestReview = {
  user: {
    login: string;
  } | null;
};

export type ListReviewsResponse = {
  status: number;
  data: PullRequestReview[];
};

export type GenericResponse = {
  status: number;
};

export type LabelPullRequestResponse = {
  status: number;
};

export type Comment = {
  owner: string;
  repo: string;
  issue_number: number;
  body: string;
};

export type CreatePullRequest = {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  maintainer_can_modify: boolean;
  draft: boolean;
};

export type ReviewRequest = {
  owner: string;
  repo: string;
  pull_number: number;
  reviewers: string[];
  team_reviewers?: string[];
};

type Payload = {
  repository?: {
    name: string;
  };
};
