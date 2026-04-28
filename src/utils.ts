import { PullRequest } from "./github.js";

export function replacePlaceholders(
  template: string,
  main: Pick<PullRequest, "body" | "user" | "number" | "title">,
  target: string,
): string {
  const issues = getMentionedIssueRefs(main.body);
  return template
    .replaceAll("${pull_author}", main.user.login)
    .replaceAll("${pull_number}", main.number.toString())
    .replaceAll("${pull_title}", main.title)
    .replaceAll("${pull_description}", main.body ?? "")
    .replaceAll("${target_branch}", target)
    .replaceAll("${issue_refs}", issues.join(" "));
}

export function getMentionedIssueRefs(body: string | null): string[] {
  const issueUrls =
    body?.match(patterns.url.global)?.map((url) => toRef(url)) ?? [];
  const issueRefs = body?.match(patterns.ref) ?? [];
  return issueUrls.concat(issueRefs).map((ref) => ref.trim());
}

const patterns = {
  url: {
    global:
      /(?:^| )(?:(?:https:\/\/)?(?:www\.)?github\.com\/(?<org>[^ \/\n]+)\/(?<repo>[^ \/\n]+)\/issues\/(?<number>[1-9][0-9]*)(?:\/)?)(?= |$)/gm,
    first:
      /(?:^| )(?:(?:https:\/\/)?(?:www\.)?github\.com\/(?<org>[^ \/\n]+)\/(?<repo>[^ \/\n]+)\/issues\/(?<number>[1-9][0-9]*)(?:\/)?)(?= |$)/m,
  },

  ref: /(?:^| )((?<org>[^\n #\/]+)\/(?<repo>[^\n #\/]+))?#(?<number>[1-9][0-9]*)(?= |$)/gm,
};

const toRef = (url: string) => {
  const result = patterns.url.first.exec(url);
  if (!result) {
    console.error(
      `Expected to transform url (${url}) to GitHub reference, but it did not match pattern`,
    );
    return "";
  }
  const [, org, repo, number] = result;
  return `${org}/${repo}#${number}`;
};
