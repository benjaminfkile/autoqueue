import * as fs from "fs";
import * as path from "path";
import { Knex } from "knex";
import { getRepoById } from "../db/repos";
import { Repo } from "../interfaces";

// Path-traversal-safe path resolver shared by every read-only repo tool
// (list_files, read_file, search). Centralizing the logic here means there is
// exactly one place where untrusted paths from the planning chat get turned
// into absolute filesystem paths, and exactly one place to harden if a new
// traversal vector turns up.
//
// Rejection rules, in order:
//   1. Absolute paths (`/etc/passwd`, `C:\Windows`).
//   2. Any segment equal to `..` (handles `../etc`, `foo/../../etc`,
//      backslash-separated variants, and a bare `..`).
//   3. Null bytes (some filesystems treat `\0` as a string terminator; reject
//      defensively before Node's fs layer would).
//   4. Joined-then-resolved path that escapes the repo root (defense in depth
//      against any segment-check we missed).
//   5. Symlink-resolved path that escapes the repo root — both the root
//      itself and the requested target are realpath'd so symlinks pointing
//      outside the clone are caught even when the literal path looks safe.
//
// Non-existent paths are allowed (callers may legitimately ask for files that
// don't exist), but the closest existing ancestor is realpath'd so we still
// catch a symlink on the existing prefix.

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

// Compute the on-disk root for a repo. Local-folder repos use their
// configured `local_path`; cloned repos sit under
// `${REPOS_PATH}/${owner}/${repo_name}`.
export function getRepoCloneRoot(repo: Repo, reposPath: string): string {
  if (repo.is_local_folder) {
    if (!repo.local_path) {
      throw new Error(
        `repo #${repo.id} is marked as a local folder but has no local_path`
      );
    }
    return repo.local_path;
  }
  if (!reposPath) {
    throw new Error("REPOS_PATH is not configured");
  }
  if (!repo.owner || !repo.repo_name) {
    throw new Error(`repo #${repo.id} is missing owner/repo_name`);
  }
  return path.join(reposPath, repo.owner, repo.repo_name);
}

// Lower-level helper: validate `requestedPath` against an already-known
// `rootDir`. Returns the realpath'd absolute path inside the root. Exposed for
// unit tests and for callers that already have the root in hand.
export function resolveSafePath(
  rootDir: string,
  requestedPath: string | undefined | null
): string {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    throw new Error(`repo clone root does not exist: ${rootDir}`);
  }

  const rel = (requestedPath ?? "").trim();

  if (rel.includes("\0")) {
    throw new PathTraversalError("path may not contain null bytes");
  }

  if (rel !== "" && path.isAbsolute(rel)) {
    throw new PathTraversalError(
      `path must be relative to the repo root: ${rel}`
    );
  }

  // Detect explicit `..` segments. We split on both forward- and
  // back-slashes so a Windows-style payload like `..\etc` is caught on
  // POSIX too.
  const segments = rel.split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    throw new PathTraversalError(`path may not contain '..': ${rel}`);
  }

  // Defense in depth: even with the segment check above, re-resolve and make
  // sure the result is still under the realpath'd root.
  const joined = path.resolve(realRoot, rel);
  if (joined !== realRoot && !joined.startsWith(realRoot + path.sep)) {
    throw new PathTraversalError(`path escapes repo root: ${rel}`);
  }

  // Symlink check: realpath the joined target. Non-existent paths are allowed
  // (read_file may legitimately fail with ENOENT later), so we walk up to the
  // closest existing ancestor and realpath that, then re-attach the missing
  // tail. This still catches symlinks on the existing prefix.
  const real = realpathClosestAncestor(joined);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new PathTraversalError(
      `path resolves outside repo root (symlink target?): ${rel}`
    );
  }

  return real;
}

function realpathClosestAncestor(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync(current);
      if (tail.length === 0) return real;
      // tail was collected child-first; reverse to get the original order.
      return path.join(real, ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`could not resolve any ancestor of ${target}`);
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// High-level helper used by the file tools. Looks up the repo by id, derives
// its clone root, and validates `requestedPath` against that root.
export async function resolveRepoPath(
  db: Knex,
  reposPath: string,
  repoId: number,
  requestedPath?: string | null
): Promise<string> {
  const repo = await getRepoById(db, repoId);
  if (!repo) {
    throw new Error(`repo #${repoId} not found`);
  }
  const cloneRoot = getRepoCloneRoot(repo, reposPath);
  return resolveSafePath(cloneRoot, requestedPath);
}
