import { EventEmitter } from "events";

jest.mock("../src/db/appSettings", () => ({
  getSetting: jest.fn(),
  setSetting: jest.fn(),
}));
import { getSetting, setSetting } from "../src/db/appSettings";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));
import { spawn } from "child_process";

import {
  RUNNER_IMAGE_NAME,
  computeDockerfileHash,
  ensureRunnerImage,
  getRunnerImageState,
  imageExists,
  resolveRunnerDockerfile,
  runnerImageTag,
  _resetRunnerImageStateForTest,
} from "../src/services/imageBuilder";

const spawnMock = spawn as jest.Mock;

// Build a fake child_process for `docker ...`. The first arg from the spawn
// call disambiguates which docker subcommand was issued so a single mock can
// cover both `image inspect` and `build` paths in the same test.
function makeFakeChild(exitCode: number, stdout = "", stderr = "") {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRunnerImageStateForTest();
});

describe("computeDockerfileHash", () => {
  it("returns a stable 12-char hex prefix of the file's sha256", () => {
    const { dockerfile } = resolveRunnerDockerfile();
    const a = computeDockerfileHash(dockerfile);
    const b = computeDockerfileHash(dockerfile);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("runnerImageTag", () => {
  it("composes the canonical `<image>:<hash>` tag", () => {
    expect(runnerImageTag("deadbeef1234")).toBe(
      `${RUNNER_IMAGE_NAME}:deadbeef1234`
    );
  });
});

describe("imageExists", () => {
  it("returns true when `docker image inspect` exits 0", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild(0));
    const result = await imageExists("grunt/runner:abc");
    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", "grunt/runner:abc"],
      expect.any(Object)
    );
  });

  it("returns false when `docker image inspect` exits non-zero (image missing)", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild(1, "", "no such image"));
    const result = await imageExists("grunt/runner:missing");
    expect(result).toBe(false);
  });
});

describe("ensureRunnerImage", () => {
  const fakeDb = {} as any;

  it("skips the build and persists the hash when the tagged image already exists", async () => {
    // image inspect returns 0 → image is already built, no docker build call.
    spawnMock.mockReturnValueOnce(makeFakeChild(0));

    const result = await ensureRunnerImage(fakeDb);

    expect(result.status).toBe("ready");
    expect(result.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", expect.stringMatching(/^grunt\/runner:[0-9a-f]{12}$/)],
      expect.any(Object)
    );
    expect(setSetting).toHaveBeenCalledWith(
      fakeDb,
      "runner_image_hash",
      result.hash
    );
  });

  it("triggers a docker build when the tagged image is missing and ends in 'ready' on success", async () => {
    spawnMock
      .mockReturnValueOnce(makeFakeChild(1)) // image inspect → missing
      .mockReturnValueOnce(makeFakeChild(0, "Successfully built\n")); // build → ok

    const result = await ensureRunnerImage(fakeDb);

    expect(result.status).toBe("ready");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const buildCall = spawnMock.mock.calls[1];
    expect(buildCall[0]).toBe("docker");
    expect(buildCall[1][0]).toBe("build");
    // Both the hash tag and the latest tag should be applied so ad-hoc
    // `docker run grunt/runner` keeps working after a rebuild.
    expect(buildCall[1]).toEqual(
      expect.arrayContaining(["-t", `${RUNNER_IMAGE_NAME}:latest`])
    );
    expect(buildCall[1]).toEqual(
      expect.arrayContaining([
        "-t",
        expect.stringMatching(/^grunt\/runner:[0-9a-f]{12}$/),
      ])
    );
    expect(setSetting).toHaveBeenCalledWith(
      fakeDb,
      "runner_image_hash",
      result.hash
    );
  });

  it("ends in 'error' when docker build fails and surfaces the captured output", async () => {
    spawnMock
      .mockReturnValueOnce(makeFakeChild(1)) // image inspect → missing
      .mockReturnValueOnce(makeFakeChild(2, "", "build failed: missing base image"));

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await ensureRunnerImage(fakeDb);
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/docker build exited with code 2/);
      expect(setSetting).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("coalesces concurrent callers into a single docker invocation chain", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild(0));

    const [a, b, c] = await Promise.all([
      ensureRunnerImage(fakeDb),
      ensureRunnerImage(fakeDb),
      ensureRunnerImage(fakeDb),
    ]);

    // One inspect, no build — the second/third callers awaited the first.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    expect(c.status).toBe("ready");
  });

  it("getRunnerImageState reflects the last completed run", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild(0));
    await ensureRunnerImage(fakeDb);
    const snap = getRunnerImageState();
    expect(snap.status).toBe("ready");
    expect(snap.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(snap.startedAt).not.toBeNull();
    expect(snap.finishedAt).not.toBeNull();
  });
});

// `getSetting` isn't currently used by ensureRunnerImage's hot path, but it
// stays available for callers that want to compare the live hash to the
// persisted one without triggering a build. This guard prevents an accidental
// removal of the export.
describe("getSetting passthrough", () => {
  it("does not interrogate app_settings during ensureRunnerImage's happy path", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild(0));
    await ensureRunnerImage({} as any);
    expect(getSetting).not.toHaveBeenCalled();
  });
});
