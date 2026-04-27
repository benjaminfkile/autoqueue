jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));

jest.mock("../src/db/repoLinks", () => ({
  listLinksForRepo: jest.fn(),
}));

import { getRepoById } from "../src/db/repos";
import { listLinksForRepo } from "../src/db/repoLinks";
import { buildMountManifest } from "../src/services/mountManifest";
import { Repo, RepoLink, RepoLinkPermission } from "../src/interfaces";

const getRepoByIdMock = getRepoById as jest.Mock;
const listLinksForRepoMock = listLinksForRepo as jest.Mock;

function repoFixture(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    owner: "acme",
    repo_name: "primary",
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

function linkFixture(overrides: Partial<RepoLink> = {}): RepoLink {
  return {
    id: 1,
    repo_a_id: 1,
    repo_b_id: 2,
    role: null,
    permission: "read" as RepoLinkPermission,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  listLinksForRepoMock.mockResolvedValue([]);
});

describe("buildMountManifest primary mount", () => {
  it("mounts a github-style primary repo at /workspace :rw under <REPOS_PATH>/<owner>/<repo>", async () => {
    const primary = repoFixture({ id: 1, owner: "acme", repo_name: "primary" });

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.primary).toEqual({
      hostPath: "/repos/acme/primary",
      containerPath: "/workspace",
      mode: "rw",
    });
  });

  it("mounts a local-folder primary repo at /workspace :rw using local_path verbatim", async () => {
    const primary = repoFixture({
      id: 1,
      is_local_folder: true,
      owner: null,
      repo_name: null,
      local_path: "/Users/me/code/widgets",
    });

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.primary).toEqual({
      hostPath: "/Users/me/code/widgets",
      containerPath: "/workspace",
      mode: "rw",
    });
  });

  it("returns an empty context list when the primary has no links (only the workspace mount)", async () => {
    const primary = repoFixture();
    listLinksForRepoMock.mockResolvedValue([]);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context).toEqual([]);
    // listLinksForRepo is queried with the primary's id, not repo_a_id —
    // listLinksForRepo handles the symmetric OR-match internally.
    expect(listLinksForRepoMock).toHaveBeenCalledWith(expect.anything(), 1);
  });
});

describe("buildMountManifest context mounts (Phase 10 mount surface)", () => {
  it("translates a read link to a :ro mount at /context/<linked-repo-name>", async () => {
    const primary = repoFixture({ id: 1, repo_name: "primary" });
    const linked = repoFixture({ id: 2, owner: "acme", repo_name: "shared" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ repo_a_id: 1, repo_b_id: 2, permission: "read" }),
    ]);
    getRepoByIdMock.mockResolvedValue(linked);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context).toHaveLength(1);
    expect(manifest.context[0]).toEqual({
      hostPath: "/repos/acme/shared",
      containerPath: "/context/shared",
      mode: "ro",
    });
  });

  it("translates a write link to a :rw mount (the primary feature of Phase 10)", async () => {
    const primary = repoFixture({ id: 1 });
    const linked = repoFixture({ id: 2, owner: "acme", repo_name: "shared" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ repo_a_id: 1, repo_b_id: 2, permission: "write" }),
    ]);
    getRepoByIdMock.mockResolvedValue(linked);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context[0]).toEqual({
      hostPath: "/repos/acme/shared",
      containerPath: "/context/shared",
      mode: "rw",
    });
  });

  it("resolves the 'other' side regardless of which column the primary appears in", async () => {
    // listLinksForRepo returns rows where the primary may be in either repo_a
    // or repo_b. The manifest must still mount the *other* repo, not the primary.
    const primary = repoFixture({ id: 5 });
    const linked = repoFixture({ id: 9, owner: "acme", repo_name: "shared" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ repo_a_id: 9, repo_b_id: 5, permission: "read" }),
    ]);
    getRepoByIdMock.mockResolvedValue(linked);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(getRepoByIdMock).toHaveBeenCalledWith(expect.anything(), 9);
    expect(manifest.context[0].hostPath).toBe("/repos/acme/shared");
  });

  it("emits one mount per direct link (no transitive walk — only repos that appear in repo_links for X)", async () => {
    // X has links to Y and Z. listLinksForRepo returns those rows. Even if Y
    // is itself linked to W (a transitive link), W must NOT show up in X's
    // manifest. We model this by ensuring the manifest builder NEVER consults
    // listLinksForRepo with anything other than the primary repo's id.
    const primary = repoFixture({ id: 1 });
    const linkedY = repoFixture({ id: 2, owner: "o", repo_name: "y" });
    const linkedZ = repoFixture({ id: 3, owner: "o", repo_name: "z" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ id: 10, repo_a_id: 1, repo_b_id: 2 }),
      linkFixture({ id: 11, repo_a_id: 1, repo_b_id: 3 }),
    ]);
    getRepoByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 2) return linkedY;
      if (id === 3) return linkedZ;
      return undefined;
    });

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context).toHaveLength(2);
    expect(manifest.context.map((m) => m.containerPath)).toEqual([
      "/context/y",
      "/context/z",
    ]);
    // Crucially, listLinksForRepo was NOT called for the linked repos (no
    // transitive walk).
    expect(listLinksForRepoMock).toHaveBeenCalledTimes(1);
    expect(listLinksForRepoMock).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("preserves the per-link permission independently (mixed read/write links produce mixed modes)", async () => {
    const primary = repoFixture({ id: 1 });
    const readLinked = repoFixture({ id: 2, owner: "o", repo_name: "ro-repo" });
    const writeLinked = repoFixture({ id: 3, owner: "o", repo_name: "rw-repo" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ id: 10, repo_a_id: 1, repo_b_id: 2, permission: "read" }),
      linkFixture({ id: 11, repo_a_id: 1, repo_b_id: 3, permission: "write" }),
    ]);
    getRepoByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 2) return readLinked;
      if (id === 3) return writeLinked;
      return undefined;
    });

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    const byPath = Object.fromEntries(
      manifest.context.map((m) => [m.containerPath, m])
    );
    expect(byPath["/context/ro-repo"].mode).toBe("ro");
    expect(byPath["/context/rw-repo"].mode).toBe("rw");
  });

  it("uses local_path basename for a local-folder linked repo (no owner/repo_name available)", async () => {
    const primary = repoFixture({ id: 1 });
    const linked = repoFixture({
      id: 2,
      owner: null,
      repo_name: null,
      is_local_folder: true,
      local_path: "/Users/me/code/utils",
    });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ repo_a_id: 1, repo_b_id: 2, permission: "read" }),
    ]);
    getRepoByIdMock.mockResolvedValue(linked);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context[0]).toEqual({
      hostPath: "/Users/me/code/utils",
      containerPath: "/context/utils",
      mode: "ro",
    });
  });

  it("disambiguates colliding container names by appending the repo id (so two linked repos named 'shared' don't clobber each other)", async () => {
    const primary = repoFixture({ id: 1 });
    const linkedA = repoFixture({ id: 2, owner: "alice", repo_name: "shared" });
    const linkedB = repoFixture({ id: 3, owner: "bob", repo_name: "shared" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ id: 10, repo_a_id: 1, repo_b_id: 2 }),
      linkFixture({ id: 11, repo_a_id: 1, repo_b_id: 3 }),
    ]);
    getRepoByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 2) return linkedA;
      if (id === 3) return linkedB;
      return undefined;
    });

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context.map((m) => m.containerPath)).toEqual([
      "/context/shared",
      "/context/shared-3",
    ]);
  });

  it("skips a link whose 'other' repo no longer exists (orphan link, not a fatal error)", async () => {
    const primary = repoFixture({ id: 1 });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ id: 10, repo_a_id: 1, repo_b_id: 99 }),
    ]);
    getRepoByIdMock.mockResolvedValue(undefined);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context).toEqual([]);
  });

  it("skips a link whose 'other' repo is misconfigured (e.g. local-folder repo with no local_path) without aborting the whole task", async () => {
    const primary = repoFixture({ id: 1 });
    const broken = repoFixture({
      id: 2,
      is_local_folder: true,
      owner: null,
      repo_name: null,
      local_path: null, // misconfigured — getRepoCloneRoot will throw
    });
    const ok = repoFixture({ id: 3, owner: "o", repo_name: "good" });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ id: 10, repo_a_id: 1, repo_b_id: 2 }),
      linkFixture({ id: 11, repo_a_id: 1, repo_b_id: 3 }),
    ]);
    getRepoByIdMock.mockImplementation(async (_db, id: number) => {
      if (id === 2) return broken;
      if (id === 3) return ok;
      return undefined;
    });

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const manifest = await buildMountManifest({} as any, primary, "/repos");
      // Only the good repo survives; the misconfigured one is logged + skipped
      // so the whole task isn't blocked by a single bad link.
      expect(manifest.context).toHaveLength(1);
      expect(manifest.context[0].containerPath).toBe("/context/good");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("never adds a self-mount even if a (defensively) self-referencing link slipped into the table", async () => {
    const primary = repoFixture({ id: 1 });

    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ id: 10, repo_a_id: 1, repo_b_id: 1, permission: "write" }),
    ]);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(manifest.context).toEqual([]);
    // We must not even try to load the primary as the 'other' side of the link.
    expect(getRepoByIdMock).not.toHaveBeenCalled();
  });

  it("returns an immutable, host-scoped manifest — only paths in the manifest can leak into the container", async () => {
    // This is a contract test for acceptance-criterion #3: no host paths beyond
    // the ones in the manifest are visible. The manifest is the *only* source
    // of truth for what gets bind-mounted, so we assert that its shape contains
    // exactly { primary, context } and no other host-path-bearing fields.
    const primary = repoFixture({ id: 1, owner: "acme", repo_name: "primary" });
    const linked = repoFixture({ id: 2, owner: "acme", repo_name: "shared" });
    listLinksForRepoMock.mockResolvedValue([
      linkFixture({ repo_a_id: 1, repo_b_id: 2, permission: "read" }),
    ]);
    getRepoByIdMock.mockResolvedValue(linked);

    const manifest = await buildMountManifest({} as any, primary, "/repos");

    expect(Object.keys(manifest).sort()).toEqual(["context", "primary"]);
    // Every host path in the manifest is one we put there explicitly.
    const allHostPaths = [manifest.primary.hostPath, ...manifest.context.map((m) => m.hostPath)];
    expect(allHostPaths).toEqual(["/repos/acme/primary", "/repos/acme/shared"]);
  });
});
