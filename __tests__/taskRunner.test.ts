jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));

jest.mock("../src/db/tasks", () => ({
  getTaskById: jest.fn(),
  getChildTasks: jest.fn(),
  updateTask: jest.fn(),
  getTasksByRepoId: jest.fn(),
}));

jest.mock("../src/db/acceptanceCriteria", () => ({
  getCriteriaByTaskId: jest.fn(),
}));

jest.mock("../src/services/git", () => ({
  cloneOrPull: jest.fn(),
  checkoutBaseBranch: jest.fn(),
  createTaskBranch: jest.fn(),
  commitAndPushTask: jest.fn(),
  mergeTaskIntoBase: jest.fn(),
  hasUncommittedChanges: jest.fn(),
}));

jest.mock("../src/services/github", () => ({
  createPullRequest: jest.fn(),
}));

jest.mock("../src/services/claudeRunner", () => ({
  runClaudeOnTask: jest.fn(),
}));

import { getRepoById } from "../src/db/repos";
import {
  getTaskById,
  updateTask,
  getChildTasks,
  getTasksByRepoId,
} from "../src/db/tasks";
import { getCriteriaByTaskId } from "../src/db/acceptanceCriteria";
import { runClaudeOnTask } from "../src/services/claudeRunner";
import { runTask } from "../src/services/taskRunner";

const getTaskByIdMock = getTaskById as jest.Mock;
const getRepoByIdMock = getRepoById as jest.Mock;
const getCriteriaMock = getCriteriaByTaskId as jest.Mock;
const updateTaskMock = updateTask as jest.Mock;
const runClaudeMock = runClaudeOnTask as jest.Mock;
const getChildTasksMock = getChildTasks as jest.Mock;
const getTasksByRepoIdMock = getTasksByRepoId as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  getChildTasksMock.mockResolvedValue([]);
  getTasksByRepoIdMock.mockResolvedValue([]);
});

describe("runTask", () => {
  it("does NOT redundantly set the leaf task status to 'active' (the claim already did that)", async () => {
    // Top-level task with no parent so no ancestor walk happens.
    const task = {
      id: 42,
      repo_id: 1,
      parent_id: null,
      title: "leaf",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "host:123",
      leased_until: new Date(),
      created_at: new Date(),
    };
    const repo = {
      id: 1,
      owner: null,
      repo_name: null,
      active: true,
      base_branch: "main",
      base_branch_parent: "main",
      require_pr: false,
      github_token: null,
      is_local_folder: true,
      local_path: "/tmp/repo",
      created_at: new Date(),
    };

    getTaskByIdMock.mockResolvedValue(task);
    getRepoByIdMock.mockResolvedValue(repo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(task);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    const result = await runTask({} as any, secrets, 1, 42);

    expect(result).toBe("success");

    // No call to updateTask on the leaf task with status: 'active'.
    const activeCallsOnLeaf = updateTaskMock.mock.calls.filter(
      ([, id, data]) => id === 42 && data && data.status === "active"
    );
    expect(activeCallsOnLeaf).toHaveLength(0);
  });

  it("still walks up parent chain and activates pending ancestors", async () => {
    const leaf = {
      id: 42,
      repo_id: 1,
      parent_id: 10,
      title: "leaf",
      description: "",
      order_position: 0,
      status: "active",
      retry_count: 0,
      pr_url: null,
      worker_id: "host:123",
      leased_until: new Date(),
      created_at: new Date(),
    };
    const ancestor = {
      ...leaf,
      id: 10,
      parent_id: null,
      title: "parent",
      status: "pending",
    };
    const repo = {
      id: 1,
      owner: null,
      repo_name: null,
      active: true,
      base_branch: "main",
      base_branch_parent: "main",
      require_pr: false,
      github_token: null,
      is_local_folder: true,
      local_path: "/tmp/repo",
      created_at: new Date(),
    };

    getTaskByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 42) return leaf;
      if (id === 10) return ancestor;
      return undefined;
    });
    getRepoByIdMock.mockResolvedValue(repo);
    getCriteriaMock.mockResolvedValue([]);
    runClaudeMock.mockResolvedValue({ success: true, output: "ok" });
    updateTaskMock.mockResolvedValue(leaf);

    const secrets: any = { REPOS_PATH: "/tmp", ANTHROPIC_API_KEY: "x" };
    await runTask({} as any, secrets, 1, 42);

    // The pending ancestor should have been activated.
    const ancestorActivation = updateTaskMock.mock.calls.find(
      ([, id, data]) => id === 10 && data && data.status === "active"
    );
    expect(ancestorActivation).toBeDefined();

    // But the leaf itself was never re-activated.
    const leafActivation = updateTaskMock.mock.calls.find(
      ([, id, data]) => id === 42 && data && data.status === "active"
    );
    expect(leafActivation).toBeUndefined();
  });
});
