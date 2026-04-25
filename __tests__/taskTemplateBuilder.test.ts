import { buildTemplateFromRepo } from "../src/services/taskTemplateBuilder";

jest.mock("../src/db/tasks");
jest.mock("../src/db/acceptanceCriteria");

import { getTasksByRepoId } from "../src/db/tasks";
import { getCriteriaByTaskId } from "../src/db/acceptanceCriteria";

type MockTask = {
  id: number;
  repo_id: number;
  parent_id: number | null;
  title: string;
  description: string;
  order_position: number;
};

function task(overrides: Partial<MockTask> & Pick<MockTask, "id" | "title">): MockTask {
  return {
    repo_id: 7,
    parent_id: null,
    description: "",
    order_position: 0,
    ...overrides,
  };
}

describe("buildTemplateFromRepo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCriteriaByTaskId as jest.Mock).mockResolvedValue([]);
  });

  it("captures the entire tree under the repo when root_task_ids is omitted", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      task({ id: 1, title: "Root A", order_position: 0 }),
      task({ id: 2, title: "Child A1", parent_id: 1, order_position: 0 }),
      task({ id: 3, title: "Child A2", parent_id: 1, order_position: 1 }),
      task({ id: 4, title: "Root B", order_position: 1 }),
    ]);

    const tree = await buildTemplateFromRepo({} as never, 7);

    expect(tree.parents).toHaveLength(2);
    expect(tree.parents[0].title).toBe("Root A");
    expect(tree.parents[0].children).toHaveLength(2);
    expect(tree.parents[0].children?.[0].title).toBe("Child A1");
    expect(tree.parents[0].children?.[1].title).toBe("Child A2");
    expect(tree.parents[1].title).toBe("Root B");
    expect(tree.parents[1].children).toBeUndefined();
  });

  it("respects order_position when sorting siblings (lowest first)", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      // Intentionally out-of-order to exercise the sort step.
      task({ id: 1, title: "Second", order_position: 1 }),
      task({ id: 2, title: "First", order_position: 0 }),
      task({ id: 3, title: "B-second", parent_id: 2, order_position: 1 }),
      task({ id: 4, title: "B-first", parent_id: 2, order_position: 0 }),
    ]);

    const tree = await buildTemplateFromRepo({} as never, 7);

    expect(tree.parents.map((p) => p.title)).toEqual(["First", "Second"]);
    expect(tree.parents[0].children?.map((c) => c.title)).toEqual([
      "B-first",
      "B-second",
    ]);
  });

  it("attaches each task's acceptance criteria in order", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      task({ id: 1, title: "Root" }),
    ]);
    (getCriteriaByTaskId as jest.Mock).mockResolvedValueOnce([
      { id: 10, task_id: 1, description: "first", order_position: 0, met: false },
      { id: 11, task_id: 1, description: "second", order_position: 1, met: true },
    ]);

    const tree = await buildTemplateFromRepo({} as never, 7);

    expect(tree.parents[0].acceptance_criteria).toEqual(["first", "second"]);
  });

  it("includes description only when non-empty (so a downstream proposal isn't padded with empty strings)", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      task({ id: 1, title: "With desc", description: "do the thing" }),
      task({ id: 2, title: "No desc", description: "" }),
    ]);

    const tree = await buildTemplateFromRepo({} as never, 7);

    expect(tree.parents[0].description).toBe("do the thing");
    expect(tree.parents[1].description).toBeUndefined();
  });

  it("strips runtime-only state — no status / retry_count / pr_url / order_position leaks into the proposal", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      {
        id: 1,
        repo_id: 7,
        parent_id: null,
        title: "Root",
        description: "x",
        order_position: 0,
        status: "done",
        retry_count: 5,
        pr_url: "https://github.com/x/y/pull/1",
        log_path: "/tmp/x.log",
        leased_until: new Date(),
        worker_id: "w-1",
        ordering_mode: "parallel",
        requires_approval: true,
        created_at: new Date(),
      },
    ]);

    const tree = await buildTemplateFromRepo({} as never, 7);

    const node = tree.parents[0];
    expect(node).toEqual({ title: "Root", description: "x" });
    // No runtime state should appear on the captured node — the materializer
    // assigns these fresh when the template is replayed.
    expect(node).not.toHaveProperty("status");
    expect(node).not.toHaveProperty("retry_count");
    expect(node).not.toHaveProperty("pr_url");
    expect(node).not.toHaveProperty("order_position");
    expect(node).not.toHaveProperty("log_path");
  });

  it("restricts the captured tree to the supplied root_task_ids in the order given", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      task({ id: 1, title: "Root A", order_position: 0 }),
      task({ id: 2, title: "Root B", order_position: 1 }),
      task({ id: 3, title: "Root C", order_position: 2 }),
      task({ id: 4, title: "A-child", parent_id: 1, order_position: 0 }),
    ]);

    const tree = await buildTemplateFromRepo({} as never, 7, [3, 1]);

    expect(tree.parents.map((p) => p.title)).toEqual(["Root C", "Root A"]);
    // Children of the included root come along; the unselected root is gone.
    expect(tree.parents[1].children?.[0].title).toBe("A-child");
  });

  it("throws when a supplied root id is not actually a top-level task (caller bug, not silent drop)", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([
      task({ id: 1, title: "Root" }),
      task({ id: 2, title: "Child", parent_id: 1 }),
    ]);

    // 2 is a child, not a root — that's a misuse and must surface, otherwise
    // the GUI would silently produce an empty template.
    await expect(buildTemplateFromRepo({} as never, 7, [2])).rejects.toThrow(
      /not a top-level task/
    );
  });

  it("throws when the repo has no tasks at all", async () => {
    (getTasksByRepoId as jest.Mock).mockResolvedValueOnce([]);

    await expect(buildTemplateFromRepo({} as never, 7)).rejects.toThrow(
      /no tasks/i
    );
  });
});
