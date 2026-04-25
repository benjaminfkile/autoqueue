import { Knex } from "knex";
import { createCriterion } from "../db/acceptanceCriteria";
import { createTask } from "../db/tasks";
import { ProposedTaskNode, TaskTreeProposal } from "./chatService";

export interface MaterializedTaskNode {
  id: number;
  title: string;
  parent_id: number | null;
  order_position: number;
  acceptance_criteria_ids: number[];
  children: MaterializedTaskNode[];
}

export interface MaterializedTaskTree {
  parents: MaterializedTaskNode[];
}

// Insert an entire proposed task tree under `repoId` in a single transaction.
// Either every task + acceptance criterion is persisted, or nothing is — the
// transaction rolls back on the first failure, so callers never see a half-
// written tree. The returned shape mirrors the input so the GUI can navigate
// straight to any of the new tasks by id.
export async function materializeTaskTree(
  db: Knex,
  repoId: number,
  proposal: TaskTreeProposal
): Promise<MaterializedTaskTree> {
  return db.transaction(async (trx) => {
    const parents: MaterializedTaskNode[] = [];
    for (let i = 0; i < proposal.parents.length; i++) {
      parents.push(
        await materializeNode(trx, repoId, proposal.parents[i], null, i)
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
    acceptance_criteria_ids,
    children,
  };
}
