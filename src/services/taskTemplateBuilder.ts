import { Knex } from "knex";
import { getCriteriaByTaskId } from "../db/acceptanceCriteria";
import { getTasksByRepoId } from "../db/tasks";
import { Task } from "../interfaces";
import { ProposedTaskNode, TaskTreeProposal } from "./chatService";

// Build a TaskTreeProposal from an existing repo's task tree. The proposal
// contains only the structural fields the materializer cares about (title,
// description, acceptance criteria, children) — runtime-only state like
// status, retry_count, pr_url, log_path, leases, and order_position is
// intentionally dropped so a template instantiated into a fresh repo starts
// clean. `rootTaskIds`, when supplied, restricts the captured tree to those
// roots (each must already be a top-level parent in the repo); otherwise every
// top-level task in the repo is included.
export async function buildTemplateFromRepo(
  db: Knex,
  repoId: number,
  rootTaskIds?: number[]
): Promise<TaskTreeProposal> {
  const tasks = await getTasksByRepoId(db, repoId);
  if (tasks.length === 0) {
    throw new Error("Repo has no tasks to capture into a template");
  }

  const byParent = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const key = t.parent_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.order_position - b.order_position);
  }

  const allRoots = byParent.get(null) ?? [];
  let roots = allRoots;
  if (rootTaskIds && rootTaskIds.length > 0) {
    const byId = new Map(allRoots.map((t) => [t.id, t]));
    const selected: Task[] = [];
    for (const id of rootTaskIds) {
      const root = byId.get(id);
      if (!root) {
        throw new Error(
          `Task ${id} is not a top-level task in repo ${repoId}`
        );
      }
      selected.push(root);
    }
    roots = selected;
  }

  if (roots.length === 0) {
    throw new Error("No top-level tasks selected for template");
  }

  const parents: ProposedTaskNode[] = [];
  for (const root of roots) {
    parents.push(await buildNode(db, root, byParent));
  }
  return { parents };
}

async function buildNode(
  db: Knex,
  task: Task,
  byParent: Map<number | null, Task[]>
): Promise<ProposedTaskNode> {
  const node: ProposedTaskNode = { title: task.title };
  if (task.description && task.description.length > 0) {
    node.description = task.description;
  }

  const criteria = await getCriteriaByTaskId(db, task.id);
  if (criteria.length > 0) {
    node.acceptance_criteria = criteria.map((c) => c.description);
  }

  const children = byParent.get(task.id) ?? [];
  if (children.length > 0) {
    const childNodes: ProposedTaskNode[] = [];
    for (const child of children) {
      childNodes.push(await buildNode(db, child, byParent));
    }
    node.children = childNodes;
  }

  return node;
}
