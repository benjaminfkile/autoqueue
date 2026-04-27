import { spawn } from "child_process";

// Probes whether the local Docker daemon is reachable. Used to halt the worker
// (and surface a friendly UI message) when Docker Desktop isn't installed or
// the daemon isn't running. The state is in-memory only — once Docker comes
// back, the next probe will flip `available` to true and the scheduler resumes
// automatically on its next tick.
//
// We invoke `docker version` rather than `docker info` because version exits
// non-zero in the same way `info` does when the daemon is unreachable, but it
// short-circuits faster (no plugin walk) and produces a smaller error blob.

export const DOCKER_INSTALL_URL =
  "https://www.docker.com/products/docker-desktop/";

export interface DockerProbeResult {
  available: boolean;
  error: string | null;
}

export interface DockerProbeState {
  available: boolean;
  error: string | null;
  lastCheckedAt: string | null;
}

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_THROTTLE_MS = 2_000;

let state: DockerProbeState = {
  available: false,
  error: null,
  lastCheckedAt: null,
};

let inflight: Promise<DockerProbeResult> | null = null;

export function _resetDockerProbeStateForTest(): void {
  state = {
    available: false,
    error: null,
    lastCheckedAt: null,
  };
  inflight = null;
}

export function getDockerState(): DockerProbeState {
  return { ...state };
}

// Run `docker version` once and resolve with the captured outcome. Each call
// spawns a fresh subprocess; callers that want throttling should use
// `refreshDockerState`.
export function probeDocker(): Promise<DockerProbeResult> {
  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const settle = (result: DockerProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({
        available: false,
        error: `Failed to spawn docker: ${(err as Error).message}`,
      });
      return;
    }

    child.stdout!.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      settle({
        available: false,
        error: `Timed out probing docker (${PROBE_TIMEOUT_MS}ms)`,
      });
    }, PROBE_TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0 && stdoutBuf.trim().length > 0) {
        settle({ available: true, error: null });
        return;
      }
      const combined = (stderrBuf + stdoutBuf).trim();
      const reason =
        combined.length > 0
          ? combined.slice(-500)
          : `docker version exited with code ${code}`;
      settle({ available: false, error: reason });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const message =
        err.code === "ENOENT"
          ? "Docker is not installed or not on PATH"
          : err.message;
      settle({ available: false, error: message });
    });
  });
}

// Update module state from a fresh probe. Concurrent calls coalesce. Calls
// within `PROBE_THROTTLE_MS` of the last successful probe reuse the cached
// state — the scheduler ticks faster than Docker can plausibly transition,
// and we don't want to spawn a `docker version` per HTTP request from the SPA.
export async function refreshDockerState(options: { force?: boolean } = {}): Promise<DockerProbeState> {
  if (inflight) {
    await inflight;
    return getDockerState();
  }
  if (!options.force && state.lastCheckedAt) {
    const lastMs = Date.parse(state.lastCheckedAt);
    if (Number.isFinite(lastMs) && Date.now() - lastMs < PROBE_THROTTLE_MS) {
      return getDockerState();
    }
  }
  inflight = probeDocker();
  try {
    const result = await inflight;
    state = {
      available: result.available,
      error: result.error,
      lastCheckedAt: new Date().toISOString(),
    };
  } finally {
    inflight = null;
  }
  return getDockerState();
}
