import { EventEmitter } from "events";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));
import { spawn } from "child_process";

import {
  DOCKER_INSTALL_URL,
  getDockerState,
  probeDocker,
  refreshDockerState,
  _resetDockerProbeStateForTest,
} from "../src/services/dockerProbe";

const spawnMock = spawn as jest.Mock;

// Simulate a `docker version` child process. exitCode=0 + stdout containing
// the daemon version represents a healthy Docker; non-zero or empty stdout
// represents the daemon being unreachable.
function makeFakeChild(opts: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  errorEvent?: NodeJS.ErrnoException;
}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  setImmediate(() => {
    if (opts.errorEvent) {
      child.emit("error", opts.errorEvent);
      return;
    }
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.exitCode ?? 0);
  });
  return child;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetDockerProbeStateForTest();
});

describe("DOCKER_INSTALL_URL", () => {
  it("points at the Docker Desktop install page", () => {
    expect(DOCKER_INSTALL_URL).toBe(
      "https://www.docker.com/products/docker-desktop/"
    );
  });
});

describe("probeDocker", () => {
  it("invokes `docker version` with a server-version format flag", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "26.1.4\n" }));

    await probeDocker();

    expect(spawnMock).toHaveBeenCalledWith(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      expect.any(Object)
    );
  });

  it("returns available=true when docker exits 0 with a version on stdout", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "26.1.4\n" }));

    const result = await probeDocker();

    expect(result).toEqual({ available: true, error: null });
  });

  it("returns available=false with stderr trailer when docker exits non-zero (daemon unreachable)", async () => {
    spawnMock.mockReturnValueOnce(
      makeFakeChild({
        exitCode: 1,
        stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      })
    );

    const result = await probeDocker();

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/Cannot connect/);
  });

  it("returns a friendly message when docker is not installed (ENOENT)", async () => {
    const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    spawnMock.mockReturnValueOnce(makeFakeChild({ errorEvent: err }));

    const result = await probeDocker();

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/not installed/);
  });

  it("falls back to a synthetic error when docker exits 0 but stdout is empty", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "" }));

    const result = await probeDocker();

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/exited with code 0/);
  });
});

describe("refreshDockerState", () => {
  it("updates module state from a successful probe", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "26.1.4\n" }));

    const state = await refreshDockerState({ force: true });

    expect(state.available).toBe(true);
    expect(state.error).toBeNull();
    expect(state.lastCheckedAt).not.toBeNull();
    expect(getDockerState()).toEqual(state);
  });

  it("flips available back to true once Docker recovers", async () => {
    // First probe: daemon down.
    spawnMock.mockReturnValueOnce(
      makeFakeChild({ exitCode: 1, stderr: "Cannot connect" })
    );
    const down = await refreshDockerState({ force: true });
    expect(down.available).toBe(false);

    // Second probe: daemon back. The scheduler relies on this transition to
    // resume work automatically without operator intervention.
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "26.1.4\n" }));
    const up = await refreshDockerState({ force: true });
    expect(up.available).toBe(true);
    expect(up.error).toBeNull();
  });

  it("coalesces concurrent callers into a single docker invocation", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "26.1.4\n" }));

    const [a, b, c] = await Promise.all([
      refreshDockerState({ force: true }),
      refreshDockerState({ force: true }),
      refreshDockerState({ force: true }),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a.available).toBe(true);
    expect(b.available).toBe(true);
    expect(c.available).toBe(true);
  });

  it("reuses cached state for repeat calls within the throttle window (no force)", async () => {
    spawnMock.mockReturnValueOnce(makeFakeChild({ exitCode: 0, stdout: "26.1.4\n" }));
    const first = await refreshDockerState({ force: true });
    expect(first.available).toBe(true);

    // Without `force`, a second call within the throttle window must NOT
    // spawn another docker process — the SPA's banner polls the API every
    // 5s and we don't want to fork a child per request.
    const second = await refreshDockerState();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});
