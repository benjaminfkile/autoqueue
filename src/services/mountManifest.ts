import { Knex } from "knex";
import * as path from "path";
import { Repo } from "../interfaces";
import { getRepoById } from "../db/repos";
import { listLinksForRepo } from "../db/repoLinks";
import { getRepoCloneRoot } from "./repoPath";

// Phase 10: per-task bind-mount manifest. The agent runs inside a fresh
// container whose only host-visible paths are the ones in this manifest. Mount
// surface is:
//   primary  →  /workspace  :rw                  (the task's own repo)
//   context  →  /context/{name} :ro|:rw          (each *directly* linked repo)
//
// The mode for context mounts is derived from repo_links.permission — `read`
// links are :ro, `write` links are :rw. Transitive links are not followed:
// only the rows where the primary repo appears in repo_a_id/repo_b_id are
// considered. Anything not in this manifest is invisible to the container.

export type MountMode = "ro" | "rw";

export interface MountSpec {
  hostPath: string;
  containerPath: string;
  mode: MountMode;
}

export interface MountManifest {
  primary: MountSpec;
  context: MountSpec[];
}

// Pick a stable, filesystem-safe directory name for the linked repo's mount
// point. Git repos use repo_name; local-folder repos fall back to the local
// path's basename; otherwise we use the synthetic `repo-<id>` so two unnamed
// links can never collide.
function containerNameFor(repo: Repo): string {
  if (repo.repo_name && !repo.repo_name.includes("/")) {
    return repo.repo_name;
  }
  if (repo.local_path) {
    const base = path.basename(repo.local_path);
    if (base && base !== "." && base !== "..") {
      return base;
    }
  }
  return `repo-${repo.id}`;
}

export async function buildMountManifest(
  db: Knex,
  primaryRepo: Repo,
  reposPath: string
): Promise<MountManifest> {
  const primary: MountSpec = {
    hostPath: getRepoCloneRoot(primaryRepo, reposPath),
    containerPath: "/workspace",
    mode: "rw",
  };

  const links = await listLinksForRepo(db, primaryRepo.id);
  const seenNames = new Set<string>();
  const context: MountSpec[] = [];

  for (const link of links) {
    const otherId =
      link.repo_a_id === primaryRepo.id ? link.repo_b_id : link.repo_a_id;
    // Defensive: a self-link would shadow /workspace and is meaningless.
    if (otherId === primaryRepo.id) continue;

    const other = await getRepoById(db, otherId);
    if (!other) continue;

    let hostPath: string;
    try {
      hostPath = getRepoCloneRoot(other, reposPath);
    } catch (err) {
      // A misconfigured linked repo (missing owner/repo_name or local_path)
      // must not block the primary task — drop the mount and continue.
      console.error(
        `[mountManifest] Skipping link to repo #${other.id} — clone root unavailable:`,
        (err as Error).message
      );
      continue;
    }

    let name = containerNameFor(other);
    if (seenNames.has(name)) {
      name = `${name}-${other.id}`;
    }
    seenNames.add(name);

    context.push({
      hostPath,
      containerPath: `/context/${name}`,
      mode: link.permission === "write" ? "rw" : "ro",
    });
  }

  return { primary, context };
}
