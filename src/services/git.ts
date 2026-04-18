import simpleGit from "simple-git";
import * as fs from "fs";
import * as path from "path";

function repoPath(reposPath: string, owner: string, repoName: string): string {
  return path.join(reposPath, owner, repoName);
}

export async function cloneOrPull(
  reposPath: string,
  pat: string,
  owner: string,
  repoName: string
): Promise<void> {
  const dir = repoPath(reposPath, owner, repoName);
  if (!fs.existsSync(dir)) {
    const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
    const parentDir = path.join(reposPath, owner);
    fs.mkdirSync(parentDir, { recursive: true });
    await simpleGit().clone(remoteUrl, dir);
  } else {
    await simpleGit(dir).fetch();
  }
}

export async function checkoutBaseBranch(
  reposPath: string,
  owner: string,
  repoName: string,
  baseBranch: string
): Promise<void> {
  const git = simpleGit(repoPath(reposPath, owner, repoName));
  await git.checkout(baseBranch);
  await git.pull();
}

export async function createIssueBranch(
  reposPath: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  issueNumber: number
): Promise<void> {
  const branchName = `issue/${issueNumber}`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    await git.deleteLocalBranch(branchName, true);
  }

  await git.checkout(["-b", branchName, baseBranch]);
}

export async function commitAndPush(
  reposPath: string,
  pat: string,
  owner: string,
  repoName: string,
  issueNumber: number,
  message: string
): Promise<void> {
  const branchName = `issue/${issueNumber}`;
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.add("-A");
  await git.commit(message);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push(["--set-upstream", "origin", branchName]);
}

export async function mergeIntoBase(
  reposPath: string,
  pat: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  issueNumber: number
): Promise<void> {
  const branchName = `issue/${issueNumber}`;
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.checkout(baseBranch);
  await git.merge(["--no-ff", branchName]);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push();
  await git.deleteLocalBranch(branchName, true);
}

export async function createTaskBranch(
  reposPath: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  taskId: number
): Promise<void> {
  const branchName = `task/${taskId}`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    await git.deleteLocalBranch(branchName, true);
  }

  await git.checkout(["-b", branchName, baseBranch]);
}

export async function commitAndPushTask(
  reposPath: string,
  pat: string,
  owner: string,
  repoName: string,
  taskId: number,
  message: string
): Promise<void> {
  const branchName = `task/${taskId}`;
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.add("-A");
  await git.commit(message);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push(["--set-upstream", "origin", branchName]);
}

export async function mergeTaskIntoBase(
  reposPath: string,
  pat: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  taskId: number
): Promise<void> {
  const branchName = `task/${taskId}`;
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.checkout(baseBranch);
  await git.merge(["--no-ff", branchName]);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push();
  await git.deleteLocalBranch(branchName, true);
}

export async function hasUncommittedChanges(
  reposPath: string,
  owner: string,
  repoName: string
): Promise<boolean> {
  const git = simpleGit(repoPath(reposPath, owner, repoName));
  const status = await git.status();
  return (
    status.modified.length > 0 ||
    status.created.length > 0 ||
    status.not_added.length > 0 ||
    status.deleted.length > 0 ||
    status.renamed.length > 0 ||
    status.staged.length > 0
  );
}
