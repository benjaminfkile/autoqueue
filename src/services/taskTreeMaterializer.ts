import { Knex } from "knex";
import { createCriterion } from "../db/acceptanceCriteria";
import { createTask } from "../db/tasks";
import { ProposedTaskNode, TaskTreeProposal } from "./chatService";

export interface MaterializedTaskNode {
  id: number;
  title: string;
  parent_id: number | null;
  order_position: number;
  // The repo this subtree was actually written against. Surfaces the per-
  // parent repo_id override so callers (and the GUI) can deep-link to the
  // right repo without re-deriving it from the proposal.
  repo_id: number;
  acceptance_criteria_ids: number[];
  children: MaterializedTaskNode[];
}

export interface MaterializedTaskTree {
  parents: MaterializedTaskNode[];
}

// Insert an entire proposed task tree in a single transaction. Each top-level
// parent may override the target repo via `node.repo_id` — when present, that
// subtree (and every descendant under it) is written against that repo;
// otherwise the subtree falls back to the `defaultRepoId` arg. This is what
// lets a single multi-repo proposal land tasks across the chat's linked repos
// in one shot. Either every task + acceptance criterion is persisted, or
// nothing is — the transaction rolls back on the first failure, so callers
// never see a half-written tree across repos.
export async function materializeTaskTree(
  db: Knex,
  defaultRepoId: number,
  proposal: TaskTreeProposal
): Promise<MaterializedTaskTree> {
  return db.transaction(async (trx) => {
    const parents: MaterializedTaskNode[] = [];
    for (let i = 0; i < proposal.parents.length; i++) {
      const parent = proposal.parents[i];
      const subtreeRepoId = parent.repo_id ?? defaultRepoId;
      parents.push(
        await materializeNode(trx, subtreeRepoId, parent, null, i)
      );
    }
    return { parents };
  });
}

async function materializeNode(
  trx: Knex,
  repoId: number,
  node: ProposedTaskNode,
  parentId: number | null,
  order: number
): Promise<MaterializedTaskNode> {
  const task = await createTask(trx, {
    repo_id: repoId,
    parent_id: parentId,
    title: node.title,
    description: node.description ?? "",
    order_position: order,
  });

  const acceptance_criteria_ids: number[] = [];
  if (node.acceptance_criteria) {
    for (let i = 0; i < node.acceptance_criteria.length; i++) {
      const criterion = await createCriterion(trx, {
        task_id: task.id,
        description: node.acceptance_criteria[i],
        order_position: i,
      });
      acceptance_criteria_ids.push(criterion.id);
    }
  }

  const children: MaterializedTaskNode[] = [];
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      children.push(
        await materializeNode(trx, repoId, node.children[i], task.id, i)
      );
    }
  }

  return {
    id: task.id,
    title: task.title,
    parent_id: parentId,
    order_position: order,
    repo_id: repoId,
    acceptance_criteria_ids,
    children,
  };
}
