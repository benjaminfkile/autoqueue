import simpleGit from "simple-git";
import * as fs from "fs";
import * as path from "path";
import * as secrets from "../secrets";

function repoPath(reposPath: string, owner: string, repoName: string): string {
  return path.join(reposPath, owner, repoName);
}

function requireGhPat(): string {
  const pat = secrets.get("GH_PAT");
  if (!pat) {
    throw new Error(
      "GH_PAT is not configured — store a GitHub PAT in the encrypted secrets file before running git operations."
    );
  }
  return pat;
}

export async function cloneOrPull(
  reposPath: string,
  owner: string,
  repoName: string
): Promise<void> {
  const dir = repoPath(reposPath, owner, repoName);
  if (!fs.existsSync(dir)) {
    const pat = requireGhPat();
    const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
    const parentDir = path.join(reposPath, owner);
    fs.mkdirSync(parentDir, { recursive: true });
    await simpleGit().clone(remoteUrl, dir);
  } else {
    await simpleGit(dir).fetch();
  }
}

// Clone-first-then-move: clone into a sibling temp directory and only promote
// it to the final REPOS_PATH/{owner}/{repoName} location once the clone has
// succeeded. A failed clone leaves no trace at the final path, so the caller
// can safely tie the DB row insert to "the clone exists on disk" without
// risking orphaned directories.
//
// Why: callers (POST /api/repos) want an all-or-nothing handshake. Cloning
// straight to the final location and then having the insert fail (or vice
// versa) leaks state in opposite directions. Staging in a temp dir on the
// same filesystem keeps the rename atomic.
export async function cloneRepoFresh(
  reposPath: string,
  owner: string,
  repoName: string
): Promise<string> {
  const finalDir = repoPath(reposPath, owner, repoName);
  if (fs.existsSync(finalDir)) {
    throw new Error(
      `Refusing to clone: target directory already exists at ${finalDir}`
    );
  }
  const pat = requireGhPat();
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const parentDir = path.join(reposPath, owner);
  fs.mkdirSync(parentDir, { recursive: true });
  // Sibling temp dir keeps the eventual rename on the same filesystem
  // (avoiding EXDEV when REPOS_PATH and the OS temp dir live on different
  // volumes).
  const tempDir = fs.mkdtempSync(path.join(parentDir, `.tmp-${repoName}-`));

  try {
    await simpleGit().clone(remoteUrl, tempDir);
    fs.renameSync(tempDir, finalDir);
    return finalDir;
  } catch (err) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort: a leftover temp dir is unfortunate but shouldn't mask
      // the real clone failure
    }
    throw err;
  }
}

export async function checkoutBaseBranch(
  reposPath: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  baseBranchParent: string
): Promise<void> {
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  const localBranches = await git.branchLocal();
  if (!localBranches.all.includes(baseBranch)) {
    const remoteHeads = await git.listRemote(["--heads", "origin", baseBranch]);
    if (remoteHeads && remoteHeads.trim().length > 0) {
      await git.fetch(["origin", baseBranch]);
      await git.checkout(["-b", baseBranch, `origin/${baseBranch}`]);
    } else {
      await git.checkout(baseBranchParent);
      await git.pull();
      await git.checkout(["-b", baseBranch]);
      await git.push(["--set-upstream", "origin", baseBranch]);
    }
  }

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
  owner: string,
  repoName: string,
  issueNumber: number,
  message: string
): Promise<void> {
  const branchName = `issue/${issueNumber}`;
  const pat = requireGhPat();
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.add("-A");
  await git.commit(message);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push(["--set-upstream", "origin", branchName]);
}

export async function mergeIntoBase(
  reposPath: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  issueNumber: number
): Promise<void> {
  const branchName = `issue/${issueNumber}`;
  const pat = requireGhPat();
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
): Promise<string> {
  // Single ref-namespace component (no '/') so the branch never collides
  // with a base branch named 'grunt' — refs/heads/grunt and
  // refs/heads/grunt/task-N cannot coexist.
  const branchName = `grunt-task-${taskId}`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    await git.deleteLocalBranch(branchName, true);
  }

  // Best-effort remote delete so a rerun starts from a clean slate. A prior
  // attempt may have pushed (and possibly merged via a PR that didn't keep
  // the branch as an ancestor of base, e.g. squash/rebase merge); leaving
  // the stale remote in place causes the next push to fail non-fast-forward.
  // Failure here is non-fatal — the most common cause is the branch simply
  // not existing on the remote yet (first attempt).
  const pat = requireGhPat();
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  try {
    await git.remote(["set-url", "origin", remoteUrl]);
    await git.push(["origin", "--delete", branchName]);
  } catch (err) {
    console.log(
      `[git] Skipping remote delete of ${branchName} (likely doesn't exist): ${(err as Error).message}`
    );
  }

  await git.checkout(["-b", branchName, baseBranch]);
  return branchName;
}

export async function commitAndPushTask(
  reposPath: string,
  owner: string,
  repoName: string,
  branchName: string,
  message: string
): Promise<void> {
  const pat = requireGhPat();
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.add("-A");
  await git.commit(message);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push(["--set-upstream", "origin", branchName]);
}

export async function mergeTaskIntoBase(
  reposPath: string,
  owner: string,
  repoName: string,
  baseBranch: string,
  branchName: string
): Promise<void> {
  const pat = requireGhPat();
  const remoteUrl = `https://${pat}@github.com/${owner}/${repoName}.git`;
  const git = simpleGit(repoPath(reposPath, owner, repoName));

  await git.checkout(baseBranch);
  await git.merge(["--no-ff", branchName]);
  await git.remote(["set-url", "origin", remoteUrl]);
  await git.push();
  await git.deleteLocalBranch(branchName, true);
  // Remove the now-merged remote branch too. Best-effort: the branch may
  // have never been pushed (no uncommitted changes path) or may have been
  // cleaned up by another process. Don't fail the task on it.
  try {
    await git.push(["origin", "--delete", branchName]);
  } catch (err) {
    console.log(
      `[git] Skipping remote delete of ${branchName} after merge (likely already gone): ${(err as Error).message}`
    );
  }
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
