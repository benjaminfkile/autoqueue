import { Octokit } from "@octokit/rest";

export async function assignCopilot(
  pat: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: "@copilot",
  });
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

export async function promoteDraftToReady(
  pat: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const octokit = new Octokit({ auth: pat });

  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const nodeId = pr.node_id;

  await octokit.graphql(
    `mutation($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
        pullRequest {
          id
        }
      }
    }`,
    { pullRequestId: nodeId }
  );
}

export async function approvePR(
  pat: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "APPROVE",
  });
}

export async function mergePR(
  pat: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const octokit = new Octokit({ auth: pat });

  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  await octokit.pulls.merge({
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "squash",
  });

  if (pr.head.ref) {
    await octokit.git.deleteRef({
      owner,
      repo,
      ref: `heads/${pr.head.ref}`,
    });
  }
}

export async function registerWebhook(
  pat: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string
): Promise<number> {
  const octokit = new Octokit({ auth: pat });
  const { data } = await octokit.repos.createWebhook({
    owner,
    repo,
    config: {
      url: webhookUrl,
      content_type: "json",
      secret,
    },
    events: ["pull_request", "issues"],
    active: true,
  });
  return data.id;
}

export async function deregisterWebhook(
  pat: string,
  owner: string,
  repo: string,
  webhookId: number
): Promise<void> {
  const octokit = new Octokit({ auth: pat });
  await octokit.repos.deleteWebhook({
    owner,
    repo,
    hook_id: webhookId,
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
