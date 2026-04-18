import { Octokit } from "@octokit/rest";

// Label definitions for grunt status visibility
export const LABEL_WORKING = { name: "grunt-working", color: "fbca04", description: "grunt agent is currently working on this" };
export const LABEL_DONE    = { name: "grunt-done",    color: "0e8a16", description: "Completed by grunt agent" };
export const LABEL_FAILED  = { name: "grunt-failed",  color: "d93f0b", description: "grunt agent failed — needs manual attention" };

async function ensureLabel(octokit: Octokit, owner: string, repo: string, label: typeof LABEL_WORKING): Promise<void> {
  await octokit.issues.createLabel({ owner, repo, ...label }).catch(() => {
    // 422 = already exists, ignore
  });
}

export async function addIssueLabel(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: typeof LABEL_WORKING
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await ensureLabel(octokit, owner, repo, label);
  await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label.name] });
}

export async function removeIssueLabel(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number,
  labelName: string
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: labelName }).catch(() => {
    // 404 = label not on issue, ignore
  });
}

export async function closeIssue(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.issues.update({ owner, repo, issue_number: issueNumber, state: "closed", state_reason: "completed" });
}

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
