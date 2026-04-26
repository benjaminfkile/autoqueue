import { Knex } from "knex";
import {
  OrderingMode,
  Repo,
  RepoCloneStatus,
  RepoOnFailure,
  RepoOnParentChildFail,
} from "../interfaces";

export async function getActiveRepos(db: Knex): Promise<Repo[]> {
  return db<Repo>("repos").where({ active: true });
}

export async function getAllRepos(db: Knex): Promise<Repo[]> {
  return db<Repo>("repos");
}

export async function getRepoById(
  db: Knex,
  id: number
): Promise<Repo | undefined> {
  return db<Repo>("repos").where({ id }).first();
}

export async function getRepoByOwnerAndName(
  db: Knex,
  owner: string,
  repoName: string
): Promise<Repo | undefined> {
  return db<Repo>("repos").where({ owner, repo_name: repoName }).first();
}

export async function createRepo(
  db: Knex,
  data: {
    owner?: string | null;
    repo_name?: string | null;
    active?: boolean;
    base_branch?: string;
    base_branch_parent?: string;
    require_pr?: boolean;
    github_token?: string | null;
    is_local_folder?: boolean;
    local_path?: string | null;
    on_failure?: RepoOnFailure;
    max_retries?: number;
    on_parent_child_fail?: RepoOnParentChildFail;
    ordering_mode?: OrderingMode;
    clone_status?: RepoCloneStatus;
    clone_error?: string | null;
  }
): Promise<Repo> {
  const [repo] = await db<Repo>("repos").insert(data).returning("*");
  return repo;
}

export async function updateRepo(
  db: Knex,
  id: number,
  data: Partial<Repo>
): Promise<Repo> {
  const [repo] = await db<Repo>("repos").where({ id }).update(data).returning("*");
  return repo;
}

export async function deleteRepo(db: Knex, id: number): Promise<void> {
  await db<Repo>("repos").where({ id }).delete();
}
