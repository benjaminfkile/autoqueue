import { Octokit } from "@octokit/rest";

export async function createPullRequest(options: {
  token: string;
  owner: string;
  repoName: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<{ url: string; number: number }> {
  if (!options.token) {
    throw new Error(
      "GitHub token is required to create a pull request. Set GH_PAT in secrets or github_token on the repo."
    );
  }

  const octokit = new Octokit({ auth: options.token });

  const { data } = await octokit.pulls.create({
    owner: options.owner,
    repo: options.repoName,
    head: options.head,
    base: options.base,
    title: options.title,
    body: options.body,
  });

  return { url: data.html_url, number: data.number };
}
