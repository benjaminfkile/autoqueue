import { Octokit } from "@octokit/rest";

export async function assignHuman(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
  username: string
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.issues.addAssignees({
    owner,
    repo,
    issue_number: issueNumber,
    assignees: [username],
  });
}

export async function postIssueComment(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

export async function getGithubIssueState(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<"open" | "closed"> {
  const octokit = new Octokit({ auth: pat });
  const { data } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });
  return data.state as "open" | "closed";
}

export async function getSubIssueNumbers(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<number[]> {
  const octokit = new Octokit({ auth: pat });
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
    {
      owner,
      repo,
      issue_number: issueNumber,
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
    }
  );
  return (data as Array<{ number: number }>).map((i) => i.number);
}

export async function getOpenIssues(
  pat: string,
  owner: string,
  repo: string
): Promise<Awaited<ReturnType<Octokit["issues"]["listForRepo"]>>["data"]> {
  const octokit = new Octokit({ auth: pat });
  const issues: Awaited<ReturnType<Octokit["issues"]["listForRepo"]>>["data"] = [];

  let page = 1;
  while (true) {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "open",
      per_page: 100,
      page,
    });
    issues.push(...data);
    if (data.length < 100) break;
    page++;
  }

  return issues;
}

export async function getIssueDetails(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  parent_issue_number: number | null;
}> {
  const octokit = new Octokit({ auth: pat });
  const { data } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const body = data.body ?? "";

  const parentMatch =
    body.match(/Parent:\s*#(\d+)/) ??
    body.match(/https?:\/\/[^\s]*\/issues\/(\d+)/);
  const parent_issue_number = parentMatch ? parseInt(parentMatch[1], 10) : null;

  const labels = (data.labels as Array<string | { name?: string | null }>).map(
    (l) => (typeof l === "string" ? l : (l.name ?? ""))
  );

  return {
    number: data.number,
    title: data.title,
    body,
    labels,
    state: data.state,
    parent_issue_number,
  };
}
