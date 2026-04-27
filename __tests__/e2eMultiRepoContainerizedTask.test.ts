// Phase 10 — End-to-end test (task #317): a write-linked task runs against a
// container whose mount surface is built from repo_links.permission.
//
// This file deliberately exercises the real implementations of:
//   - src/services/taskRunner.ts       (the orchestration)
//   - src/services/mountManifest.ts    (manifest builder, sibling task #315)
//   - src/services/claudeRunner.ts     (docker invocation, system prompt — task #316)
// while mocking only the IO boundaries (child_process.spawn, db CRUD, git,
// github, secrets, image build, docker probe). The point is to pin the contract
// that flows from a repo_links row all the way to the `docker run -v` flag, and
// to verify that contract end-to-end without spinning up a real container.
//
// Acceptance criteria covered:
//   1131 — Full happy path of a write-linked task (docker mount surface +
//          branch created + commit pushed + PR opened).
//   1132 — A third repo with no repo_links row to the primary is invisible to
//          the container (its host path never appears as a -v target).
//   1133 — Read-only links carry the `:ro` flag in the docker -v spec, which
//          delegates write rejection to the Linux kernel mount layer (any
//          attempted write returns EROFS regardless of agent intent).

import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Mock spawn so we can capture the docker invocation produced by the real
// claudeRunner. The FakeChild emits 'close' with code 0 once the runner has
// attached its handlers — that's enough to drive runTask through to the
// commit/PR pipeline.
jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

// Secrets store is consulted by taskRunner (GH_PAT / ANTHROPIC_API_KEY) and by
// claudeRunner (the same two). The real store reads from an encrypted file on
// disk; we replace it with a tiny in-memory map for the test.
jest.mock("../src/secrets", () => ({
  get: jest.fn((key: string) =>
    ({
      ANTHROPIC_API_KEY: "test-anthropic-key",
      GH_PAT: "test-gh-pat",
    } as Record<string, string | undefined>)[key]
  ),
  init: jest.fn(),
  set: jest.fn(),
  unset: jest.fn(),
  getSecretsFilePath: jest.fn(),
}));

// Image build and docker probe must short-circuit so runTask reaches the
// agent. Their real bodies shell out to docker — out of scope for an e2e mount
// surface test.
jest.mock("../src/services/imageBuilder", () => ({
  ensureRunnerImage: jest.fn().mockResolvedValue({
    status: "ready",
    hash: "test-hash",
    startedAt: null,
    finishedAt: null,
    error: null,
  }),
}));

jest.mock("../src/services/dockerProbe", () => ({
  refreshDockerState: jest.fn().mockResolvedValue({
    available: true,
    error: null,
    lastCheckedAt: null,
  }),
}));

// Webhooks fire-and-forget — they don't gate the pipeline.
jest.mock("../src/services/webhookDelivery", () => ({
  triggerWebhooks: jest.fn(),
}));

// Stub git operations: we record the calls (so the happy-path assertions can
// verify branch + commit) but skip the real fs/network work. The shape of the
// mocks matches src/services/git.ts exactly so taskRunner sees no behavioural
// difference from a successful real run.
jest.mock("../src/services/git", () => ({
  cloneOrPull: jest.fn().mockResolvedValue(undefined),
  checkoutBaseBranch: jest.fn().mockResolvedValue(undefined),
  createTaskBranch: jest
    .fn()
    .mockImplementation(
      async (_repos: string, _owner: string, _name: string, _base: string, taskId: number) =>
        `grunt-task-${taskId}`
    ),
  commitAndPushTask: jest.fn().mockResolvedValue(undefined),
  mergeTaskIntoBase: jest.fn().mockResolvedValue(undefined),
  hasUncommittedChanges: jest.fn().mockResolvedValue(true),
}));

// Stub PR creation; record args so the happy-path test can assert on owner /
// branch / title.
jest.mock("../src/services/github", () => ({
  createPullRequest: jest.fn().mockResolvedValue({
    url: "https://github.com/acme/primary/pull/1",
    number: 1,
  }),
}));

// In-memory data layer: the test seeds `repos` and `links` per scenario, and
// the mocked db helpers read from those structures. This is closer to a real
// DB than a hand-rolled per-call mock — the same data flows through all three
// production modules, so a mismatch (e.g. mountManifest asks for repo X but
// repo X isn't in `repos`) surfaces as a real bug.
type RepoRow = {
  id: number;
  owner: string | null;
  repo_name: string | null;
  active: boolean;
  base_branch: string;
  base_branch_parent: string;
  require_pr: boolean;
  github_token: string | null;
  is_local_folder: boolean;
  local_path: string | null;
  on_failure: string;
  max_retries: number;
  on_parent_child_fail: string;
  ordering_mode: string;
  clone_status: string;
  clone_error: string | null;
  created_at: Date;
};

type LinkRow = {
  id: number;
  repo_a_id: number;
  repo_b_id: number;
  role: string | null;
  permission: "read" | "write";
  created_at: Date;
};

const repos = new Map<number, RepoRow>();
const links: LinkRow[] = [];

jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(async (_db: unknown, id: number) => repos.get(id)),
}));

jest.mock("../src/db/repoLinks", () => ({
  // Sort by id ASC to mirror the real listLinksForRepo ordering — the manifest
  // emits context mounts in this order, so context-mount order in the docker
  // args is determined here.
  listLinksForRepo: jest.fn(async (_db: unknown, repoId: number) =>
    links
      .filter((l) => l.repo_a_id === repoId || l.repo_b_id === repoId)
      .sort((a, b) => a.id - b.id)
  ),
}));

jest.mock("../src/db/tasks", () => ({
  getTaskById: jest.fn(),
  getChildTasks: jest.fn().mockResolvedValue([]),
  updateTask: jest.fn().mockResolvedValue(undefined),
  getTasksByRepoId: jest.fn().mockResolvedValue([]),
  renewTaskLease: jest.fn().mockResolvedValue(undefined),
  resolveTaskModel: jest.fn().mockResolvedValue("claude-opus-4-7"),
}));

jest.mock("../src/db/acceptanceCriteria", () => ({
  getCriteriaByTaskId: jest.fn().mockResolvedValue([]),
}));

jest.mock("../src/db/taskEvents", () => ({
  recordEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/db/taskNotes", () => ({
  getNotesForTask: jest.fn().mockResolvedValue([]),
  createNote: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock("../src/db/taskUsage", () => ({
  recordTaskUsage: jest.fn().mockResolvedValue({ id: 1 }),
}));

import { spawn } from "child_process";
import { runTask } from "../src/services/taskRunner";
import { getTaskById } from "../src/db/tasks";
import { commitAndPushTask, createTaskBranch } from "../src/services/git";
import { createPullRequest } from "../src/services/github";

const spawnMock = spawn as unknown as jest.Mock;
const getTaskByIdMock = getTaskById as jest.Mock;
const commitAndPushTaskMock = commitAndPushTask as jest.Mock;
const createTaskBranchMock = createTaskBranch as jest.Mock;
const createPullRequestMock = createPullRequest as jest.Mock;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

let tmpReposRoot: string;

function makeRepo(overrides: Partial<RepoRow>): RepoRow {
  const id = overrides.id ?? 1;
  return {
    id,
    owner: "acme",
    repo_name: `repo-${id}`,
    active: true,
    base_branch: "main",
    base_branch_parent: "main",
    require_pr: false,
    github_token: null,
    is_local_folder: false,
    local_path: null,
    on_failure: "halt_repo",
    max_retries: 3,
    on_parent_child_fail: "cascade_fail",
    ordering_mode: "sequential",
    clone_status: "ready",
    clone_error: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeTask(overrides: { id: number; repo_id: number; title?: string; description?: string }) {
  return {
    id: overrides.id,
    repo_id: overrides.repo_id,
    parent_id: null,
    title: overrides.title ?? "leaf",
    description: overrides.description ?? "",
    order_position: 0,
    status: "active" as const,
    retry_count: 0,
    pr_url: null,
    worker_id: "host:1",
    leased_until: new Date(),
    created_at: new Date(),
  };
}

// Capture the docker invocation produced by the real claudeRunner. The runner
// attaches its 'close' handler synchronously after spawn returns, so deferring
// the close event one tick (setImmediate) guarantees the handler is in place
// before we fire it.
function armSpawnForSuccess(): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    setImmediate(() => child.emit("close", 0));
    return child;
  });
}

function dockerVSpecs(): string[] {
  const args = spawnMock.mock.calls[0][1] as string[];
  return args
    .map((a, i) => (a === "-v" ? args[i + 1] : null))
    .filter((v): v is string => v !== null);
}

beforeEach(() => {
  jest.clearAllMocks();
  repos.clear();
  links.length = 0;
  tmpReposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-e2e-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpReposRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

// ---------------------------------------------------------------------------
// AC #1131 — Full happy path: a write-linked task runs end-to-end. We assert
// the entire pipeline observable from outside the container:
//   - docker is invoked with the right mount surface (primary :rw + linked :rw)
//   - the agent's working tree is the primary repo
//   - branch is created on the primary
//   - commit is pushed (via our git mock, with the right branch name)
//   - PR is opened (require_pr=true)
// ---------------------------------------------------------------------------
describe("Phase 10 e2e — write-linked task happy path", () => {
  it("runs a write-linked task end-to-end: docker mounts primary :rw + linked :rw, branch created, commit pushed, PR opened", async () => {
    const primary = makeRepo({
      id: 1,
      owner: "acme",
      repo_name: "primary",
      require_pr: true,
    });
    const linkedWrite = makeRepo({
      id: 2,
      owner: "acme",
      repo_name: "linked-write",
    });
    repos.set(primary.id, primary);
    repos.set(linkedWrite.id, linkedWrite);

    links.push({
      id: 1,
      repo_a_id: primary.id,
      repo_b_id: linkedWrite.id,
      role: null,
      permission: "write",
      created_at: new Date(),
    });

    const task = makeTask({
      id: 42,
      repo_id: primary.id,
      title: "Cross-repo edit",
      description: "Modify a file in linked-write to track a new field added in primary.",
    });
    getTaskByIdMock.mockResolvedValue(task);

    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    const result = await runTask({} as any, config, primary.id, task.id);

    expect(result).toBe("success");

    // -- Mount surface visible to the kernel/container runtime --
    const vSpecs = dockerVSpecs();
    expect(vSpecs).toEqual([
      `${tmpReposRoot}/acme/primary:/workspace:rw`,
      `${tmpReposRoot}/acme/linked-write:/context/linked-write:rw`,
    ]);

    // -- Branch lifecycle: createTaskBranch is the boundary at which a new
    //    refs/heads/grunt-task-42 is materialized on the primary's clone. --
    expect(createTaskBranchMock).toHaveBeenCalledWith(
      tmpReposRoot,
      "acme",
      "primary",
      "main",
      42
    );

    // -- Commit & push pipeline: claudeRunner exited 0 and
    //    hasUncommittedChanges()==true, so the runner commits + pushes the
    //    primary branch. --
    expect(commitAndPushTaskMock).toHaveBeenCalledWith(
      tmpReposRoot,
      "acme",
      "primary",
      "grunt-task-42",
      expect.stringContaining("task #42")
    );

    // -- PR opened against the primary's base branch. --
    expect(createPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repoName: "primary",
        head: "grunt-task-42",
        base: "main",
        title: "Cross-repo edit",
      })
    );
  });

  it("the system prompt handed to the agent describes the linked-write mount as read-write so the agent knows it can edit it", async () => {
    // The prompt contract is part of the happy path: without correct prompt
    // wording, an agent reading only the prompt (not the mount table) will
    // refuse to edit the linked repo. This pins prompt+mount agreement.
    const primary = makeRepo({ id: 1, owner: "acme", repo_name: "primary" });
    const linked = makeRepo({ id: 2, owner: "acme", repo_name: "linked-rw" });
    repos.set(primary.id, primary);
    repos.set(linked.id, linked);
    links.push({
      id: 1,
      repo_a_id: primary.id,
      repo_b_id: linked.id,
      role: null,
      permission: "write",
      created_at: new Date(),
    });

    getTaskByIdMock.mockResolvedValue(makeTask({ id: 42, repo_id: primary.id }));
    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    await runTask({} as any, config, primary.id, 42);

    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toMatch(/`\/context\/linked-rw`\s*\(read-write\)/);
  });
});

// ---------------------------------------------------------------------------
// AC #1132 — A third repo with no repo_links row to the primary is invisible
// to the container. We verify this at the docker spawn boundary: the unlinked
// repo's host path never appears as a -v target in any form. Since `docker
// run` only exposes paths via -v bind mounts, "not in -v" == "not visible from
// inside the container".
// ---------------------------------------------------------------------------
describe("Phase 10 e2e — unlinked third repo is invisible to the container", () => {
  it("a repo that has NO repo_links row to the primary never appears in the docker invocation", async () => {
    const primary = makeRepo({ id: 1, owner: "acme", repo_name: "primary" });
    const linked = makeRepo({ id: 2, owner: "acme", repo_name: "linked" });
    // The "unlinked-third" repo exists in the repos table but has no row in
    // repo_links connecting it to the primary. The test is that this repo's
    // host path never reaches docker, so the container literally cannot stat
    // or open it.
    const unlinked = makeRepo({
      id: 99,
      owner: "acme",
      repo_name: "unlinked-third",
    });
    repos.set(primary.id, primary);
    repos.set(linked.id, linked);
    repos.set(unlinked.id, unlinked);

    links.push({
      id: 1,
      repo_a_id: primary.id,
      repo_b_id: linked.id,
      role: null,
      permission: "write",
      created_at: new Date(),
    });

    getTaskByIdMock.mockResolvedValue(makeTask({ id: 7, repo_id: primary.id }));
    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    const result = await runTask({} as any, config, primary.id, 7);

    expect(result).toBe("success");

    const args = spawnMock.mock.calls[0][1] as string[];
    const argsJoined = args.join(" ");

    // Neither the host path nor a /context/<name> entry for the unlinked repo
    // should appear anywhere in the docker invocation.
    expect(argsJoined).not.toContain(`${tmpReposRoot}/acme/unlinked-third`);
    expect(argsJoined).not.toContain("/context/unlinked-third");
    expect(argsJoined).not.toMatch(/unlinked-third/);

    // Sanity-check the negative assertion isn't a false positive from a global
    // mount-stripping bug: the legitimately-linked repo IS present.
    expect(argsJoined).toContain(`${tmpReposRoot}/acme/linked`);

    // And the prompt the agent receives also doesn't reference the unlinked
    // repo — defense in depth against an agent that asks for /context/unlinked.
    const prompt = args[args.length - 1];
    expect(prompt).not.toMatch(/unlinked-third/);
  });

  it("an unlinked repo with the SAME owner is also invisible — the gate is the repo_links row, not a path-prefix accident", async () => {
    // Sanity check that "invisible" really means "not in repo_links", not "not
    // under the same /repos/<owner>/ tree". Two repos with the same owner but
    // no link must still be isolated from each other.
    const primary = makeRepo({ id: 1, owner: "acme", repo_name: "primary" });
    const sibling = makeRepo({ id: 2, owner: "acme", repo_name: "sibling-no-link" });
    repos.set(primary.id, primary);
    repos.set(sibling.id, sibling);
    // intentionally no links.push(...) — the two repos share an owner but not
    // a link.

    getTaskByIdMock.mockResolvedValue(makeTask({ id: 8, repo_id: primary.id }));
    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    await runTask({} as any, config, primary.id, 8);

    const vSpecs = dockerVSpecs();
    // Only the primary :rw mount — no second -v leaked in by an over-eager
    // owner-walk or auto-discovery routine.
    expect(vSpecs).toEqual([`${tmpReposRoot}/acme/primary:/workspace:rw`]);
  });
});

// ---------------------------------------------------------------------------
// AC #1133 — Read-only links reject writes at the kernel/mount level.
//
// The runner doesn't enforce read-only-ness in code (and couldn't, even if it
// wanted to — the agent runs in a separate process and could just write to any
// path). Enforcement is delegated to the Linux kernel via the `:ro` flag on
// the docker -v bind mount: the kernel marks the mount read-only and any
// write returns EROFS regardless of agent intent.
//
// This means the contract under test is: a `read` permission link must produce
// a `:ro`-suffixed -v entry. If it ever produced `:rw`, the kernel-level
// guarantee would silently disappear even though the prompt still tells the
// agent the path is read-only.
// ---------------------------------------------------------------------------
describe("Phase 10 e2e — read-only links reject writes at the kernel/mount level", () => {
  it("a read-permission link mounts the linked repo with the docker :ro suffix (delegates write rejection to the kernel)", async () => {
    const primary = makeRepo({ id: 1, owner: "acme", repo_name: "primary" });
    const reference = makeRepo({ id: 2, owner: "acme", repo_name: "reference-only" });
    repos.set(primary.id, primary);
    repos.set(reference.id, reference);

    links.push({
      id: 1,
      repo_a_id: primary.id,
      repo_b_id: reference.id,
      role: null,
      permission: "read",
      created_at: new Date(),
    });

    getTaskByIdMock.mockResolvedValue(makeTask({ id: 11, repo_id: primary.id }));
    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    await runTask({} as any, config, primary.id, 11);

    const vSpecs = dockerVSpecs();

    // The :ro suffix is the hard guarantee — the kernel rejects writes with
    // EROFS regardless of whether the agent ignores the prompt warning.
    expect(vSpecs).toContain(
      `${tmpReposRoot}/acme/reference-only:/context/reference-only:ro`
    );

    // And critically NOT :rw — a regression that promoted read links to write
    // would silently break the read-only contract even though the system
    // prompt still says "read-only". The :ro flag is the only thing the
    // kernel sees; the prompt is advisory.
    expect(vSpecs).not.toContain(
      `${tmpReposRoot}/acme/reference-only:/context/reference-only:rw`
    );
  });

  it("mixed permissions in the same task: each link's mount mode is derived independently from its own repo_links.permission", async () => {
    // Defense in depth: a single task may have multiple linked repos with
    // different permissions. The mount mode for each must come from that
    // link's own `permission` column — not a per-task global, not the first
    // link wins, not the strictest. This pins per-link independence.
    const primary = makeRepo({ id: 1, owner: "acme", repo_name: "primary" });
    const readOnly = makeRepo({ id: 2, owner: "acme", repo_name: "ro-lib" });
    const writable = makeRepo({ id: 3, owner: "acme", repo_name: "rw-lib" });
    repos.set(primary.id, primary);
    repos.set(readOnly.id, readOnly);
    repos.set(writable.id, writable);

    links.push(
      {
        id: 1,
        repo_a_id: primary.id,
        repo_b_id: readOnly.id,
        role: null,
        permission: "read",
        created_at: new Date(),
      },
      {
        id: 2,
        repo_a_id: primary.id,
        repo_b_id: writable.id,
        role: null,
        permission: "write",
        created_at: new Date(),
      }
    );

    getTaskByIdMock.mockResolvedValue(makeTask({ id: 22, repo_id: primary.id }));
    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    await runTask({} as any, config, primary.id, 22);

    const vSpecs = dockerVSpecs();

    // Three -v entries: primary + read-only + writable. Each carries its own
    // permission label, derived independently from repo_links.permission.
    // Order is: primary first, then context mounts in listLinksForRepo order
    // (sorted by id ASC, which is the manifest's stable enumeration).
    expect(vSpecs).toEqual([
      `${tmpReposRoot}/acme/primary:/workspace:rw`,
      `${tmpReposRoot}/acme/ro-lib:/context/ro-lib:ro`,
      `${tmpReposRoot}/acme/rw-lib:/context/rw-lib:rw`,
    ]);
  });

  it("the system prompt warns the agent that writes to :ro mounts will fail at the kernel layer (EROFS) — defense in depth alongside the mount flag", async () => {
    // The prompt warning is the second half of the read-only defense story:
    // even if the agent ignores it, the :ro flag stops the write at the
    // kernel. But the warning matters too — it stops the agent from burning
    // turns retrying a failed write. This test pins both layers in one place.
    const primary = makeRepo({ id: 1, owner: "acme", repo_name: "primary" });
    const reference = makeRepo({ id: 2, owner: "acme", repo_name: "ref-lib" });
    repos.set(primary.id, primary);
    repos.set(reference.id, reference);

    links.push({
      id: 1,
      repo_a_id: primary.id,
      repo_b_id: reference.id,
      role: null,
      permission: "read",
      created_at: new Date(),
    });

    getTaskByIdMock.mockResolvedValue(makeTask({ id: 33, repo_id: primary.id }));
    armSpawnForSuccess();

    const config: any = { REPOS_PATH: tmpReposRoot };
    await runTask({} as any, config, primary.id, 33);

    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];

    // Layer 1: prompt labels the path read-only.
    expect(prompt).toMatch(/`\/context\/ref-lib`\s*\(read-only\)/);
    // Layer 2: prompt explicitly tells the agent kernel-level rejection (EROFS)
    // is the failure mode, so it doesn't try to recover via chmod or retries.
    expect(prompt).toMatch(/EROFS|read-only filesystem/i);
  });
});
