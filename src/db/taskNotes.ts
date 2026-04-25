import { Knex } from "knex";
import { NoteAuthor, NoteVisibility, TaskNote } from "../interfaces";

export async function deleteNote(
  db: Knex,
  id: number
): Promise<number> {
  return db<TaskNote>("task_notes").where({ id }).delete();
}

export async function createNote(
  db: Knex,
  data: {
    task_id: number;
    author: NoteAuthor;
    visibility: NoteVisibility;
    content: string;
    tags?: string[];
  }
): Promise<TaskNote> {
  const [row] = await db<TaskNote>("task_notes")
    .insert({
      task_id: data.task_id,
      author: data.author,
      visibility: data.visibility,
      tags: JSON.stringify(data.tags ?? []) as unknown as string[],
      content: data.content,
    })
    .returning("*");
  return row;
}

// Resolves visibility against the task tree. A note authored on task N is
// visible to task X when:
//   - n.task_id == X                                                 (the
//     authoring task always sees its own notes regardless of visibility)
//   - visibility = 'siblings'    AND N and X share the same parent_id
//                                 (within the same repo, X != N)
//   - visibility = 'descendants' AND N is a strict ancestor of X
//   - visibility = 'ancestors'   AND N is a strict descendant of X
//   - visibility = 'all'         AND N and X live in the same repo
export async function getNotesForTask(
  db: Knex,
  taskId: number
): Promise<TaskNote[]> {
  const result = await db.raw<{ rows: TaskNote[] }>(
    `WITH RECURSIVE
     ancestors_of_target AS (
       SELECT t.parent_id AS id
       FROM tasks t
       WHERE t.id = ? AND t.parent_id IS NOT NULL
       UNION ALL
       SELECT t.parent_id
       FROM tasks t
       JOIN ancestors_of_target a ON a.id = t.id
       WHERE t.parent_id IS NOT NULL
     ),
     descendants_of_target AS (
       SELECT t.id
       FROM tasks t
       WHERE t.parent_id = ?
       UNION ALL
       SELECT t.id
       FROM tasks t
       JOIN descendants_of_target d ON t.parent_id = d.id
     ),
     target AS (
       SELECT id, repo_id, parent_id FROM tasks WHERE id = ?
     )
     SELECT n.*
     FROM task_notes n
     JOIN tasks nt ON nt.id = n.task_id
     CROSS JOIN target
     WHERE
       n.task_id = target.id
       OR (
         n.visibility = 'siblings'
         AND n.task_id != target.id
         AND nt.parent_id IS NOT DISTINCT FROM target.parent_id
         AND nt.repo_id = target.repo_id
       )
       OR (
         n.visibility = 'descendants'
         AND n.task_id IN (SELECT id FROM ancestors_of_target)
       )
       OR (
         n.visibility = 'ancestors'
         AND n.task_id IN (SELECT id FROM descendants_of_target)
       )
       OR (
         n.visibility = 'all'
         AND nt.repo_id = target.repo_id
       )
     ORDER BY n.created_at ASC, n.id ASC`,
    [taskId, taskId, taskId]
  );
  return result.rows;
}
