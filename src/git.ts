import { ExecOptions, getExecOutput } from "@actions/exec";

export class GitRefNotFoundError extends Error {
  ref: string;
  constructor(message: string, ref: string) {
    super(message);
    this.ref = ref;
  }
}

export interface GitApi {
  fetch(
    ref: string,
    pwd: string,
    depth: number,
    remote?: string,
  ): Promise<void>;
  findCommitsInRange(range: string, pwd: string): Promise<string[]>;
  findMergeCommits(commitShas: string[], pwd: string): Promise<string[]>;
  push(branchname: string, remote: string, pwd: string): Promise<number>;
  checkout(branch: string, start: string, pwd: string): Promise<void>;
  cherryPick(
    commitShas: string[],
    conflictResolution: string,
    pwd: string,
  ): Promise<string[] | null>;
}

export class Git implements GitApi {
  constructor(
    private gitCommitterName: string,
    private gitCommitterEmail: string,
    private silent: boolean = false,
  ) {}

  private async git(command: string, args: string[], pwd: string) {
    const options: ExecOptions = {
      silent: this.silent,
      cwd: pwd,
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: this.gitCommitterName,
        GIT_COMMITTER_EMAIL: this.gitCommitterEmail,
      },
      ignoreReturnCode: true,
    };
    return getExecOutput("git", [command, ...args], options);
  }

  public async fetch(
    ref: string,
    pwd: string,
    depth: number,
    remote: string = "origin",
  ) {
    const { exitCode } = await this.git(
      "fetch",
      [`--depth=${depth}`, remote, ref],
      pwd,
    );
    if (exitCode === 128) {
      throw new GitRefNotFoundError(
        `Expected to fetch '${ref}' from '${remote}', but couldn't find it`,
        ref,
      );
    } else if (exitCode !== 0) {
      throw new Error(
        `'git fetch ${remote} ${ref}' failed with exit code ${exitCode}`,
      );
    }
  }

  public async findCommitsInRange(
    range: string,
    pwd: string,
  ): Promise<string[]> {
    const { exitCode, stdout } = await this.git(
      "log",
      ['--pretty=format:"%H"', "--reverse", range],
      pwd,
    );
    if (exitCode !== 0) {
      throw new Error(
        `'git log --pretty=format:"%H" ${range}' failed with exit code ${exitCode}`,
      );
    }
    const commitShas = stdout
      .split("\n")
      .map((sha) => sha.replace(/"/g, ""))
      .filter((sha) => sha.trim() !== "");
    return commitShas;
  }

  public async findMergeCommits(
    commitShas: string[],
    pwd: string,
  ): Promise<string[]> {
    if (commitShas.length === 0) {
      return [];
    }
    const range = `${commitShas[0]}^..${commitShas[commitShas.length - 1]}`;
    const { exitCode, stdout } = await this.git(
      "rev-list",
      ["--merges", range],
      pwd,
    );
    if (exitCode !== 0) {
      throw new Error(
        `'git rev-list --merges ${range}' failed with exit code ${exitCode}`,
      );
    }
    const mergeCommitShas = stdout
      .split("\n")
      .filter((sha) => sha.trim() !== "");
    return mergeCommitShas;
  }

  public async push(branchname: string, remote: string, pwd: string) {
    const { exitCode } = await this.git(
      "push",
      ["--set-upstream", remote, branchname],
      pwd,
    );
    return exitCode;
  }

  public async checkout(branch: string, start: string, pwd: string) {
    const { exitCode } = await this.git("switch", ["-c", branch, start], pwd);
    if (exitCode !== 0) {
      throw new Error(
        `'git switch -c ${branch} ${start}' failed with exit code ${exitCode}`,
      );
    }
  }

  public async cherryPick(
    commitShas: string[],
    conflictResolution: string,
    pwd: string,
  ): Promise<string[] | null> {
    const abortCherryPickAndThrow = async (
      commitShas: string[],
      exitCode: number,
    ) => {
      await this.git("cherry-pick", ["--abort"], pwd);
      throw new Error(
        `'git cherry-pick -x ${commitShas}' failed with exit code ${exitCode}`,
      );
    };

    if (conflictResolution === `fail`) {
      const { exitCode } = await this.git(
        "cherry-pick",
        ["-x", ...commitShas],
        pwd,
      );

      if (exitCode !== 0) {
        await abortCherryPickAndThrow(commitShas, exitCode);
      }

      return null;
    } else {
      let uncommittedShas: string[] = [...commitShas];

      while (uncommittedShas.length > 0) {
        const { exitCode } = await this.git(
          "cherry-pick",
          ["-x", uncommittedShas[0]],
          pwd,
        );

        if (exitCode !== 0) {
          if (exitCode === 1) {
            if (conflictResolution === `draft_commit_conflicts`) {
              const { exitCode } = await this.git(
                "commit",
                ["--all", `-m CHERRY-PICK-CONFLICT`],
                pwd,
              );

              if (exitCode !== 0) {
                await abortCherryPickAndThrow(commitShas, exitCode);
              }

              return uncommittedShas;
            } else {
              throw new Error(
                `'Unsupported conflict_resolution method ${conflictResolution}`,
              );
            }
          } else {
            await abortCherryPickAndThrow([uncommittedShas[0]], exitCode);
          }
        }

        uncommittedShas.shift();
      }

      return null;
    }
  }
}
