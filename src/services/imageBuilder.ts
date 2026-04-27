import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Knex } from "knex";
import { getSetting, setSetting } from "../db/appSettings";

export const RUNNER_IMAGE_NAME = "grunt/runner";
export const RUNNER_IMAGE_HASH_KEY = "runner_image_hash";

export type RunnerImageStatus =
  | "idle"
  | "checking"
  | "building"
  | "ready"
  | "error";

export interface RunnerImageState {
  status: RunnerImageStatus;
  hash: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

let state: RunnerImageState = {
  status: "idle",
  hash: null,
  startedAt: null,
  finishedAt: null,
  error: null,
};

// In-flight promise: ensures concurrent callers (startup + first task) coalesce
// into a single build instead of racing two `docker build`s for the same image.
let pendingBuild: Promise<void> | null = null;

export function getRunnerImageState(): RunnerImageState {
  return { ...state };
}

export function _resetRunnerImageStateForTest(): void {
  state = {
    status: "idle",
    hash: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  pendingBuild = null;
}

// Resolve the Dockerfile path. The runner Dockerfile lives at
// `<repo>/dockerfile/runner/Dockerfile`. When the server runs compiled
// (`<repo>/dist/src/services/imageBuilder.js`) the relative `..` chain differs
// from the ts-node case, so we probe both.
export function resolveRunnerDockerfile(): {
  dockerfile: string;
  context: string;
} {
  const candidates = [
    path.resolve(__dirname, "..", "..", "dockerfile", "runner"),
    path.resolve(__dirname, "..", "..", "..", "dockerfile", "runner"),
    path.resolve(process.cwd(), "dockerfile", "runner"),
  ];
  const context = candidates.find((p) =>
    fs.existsSync(path.join(p, "Dockerfile"))
  );
  if (!context) {
    throw new Error(
      `Runner Dockerfile not found in any of: ${candidates.join(", ")}`
    );
  }
  return { dockerfile: path.join(context, "Dockerfile"), context };
}

export function computeDockerfileHash(dockerfilePath: string): string {
  const contents = fs.readFileSync(dockerfilePath);
  // Truncate to 12 hex chars — long enough to avoid collisions in practice,
  // short enough to read in `docker images` output.
  return crypto
    .createHash("sha256")
    .update(contents)
    .digest("hex")
    .slice(0, 12);
}

export function runnerImageTag(hash: string): string {
  return `${RUNNER_IMAGE_NAME}:${hash}`;
}

// Run a docker subcommand and resolve with the exit code + captured output.
function runDocker(
  args: string[],
  options: { onOutput?: (chunk: string) => void } = {}
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const onData = (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      if (options.onOutput) options.onOutput(chunk);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => resolve({ code, output }));
    child.on("error", (err) => {
      output += `\n${err.message}`;
      resolve({ code: -1, output });
    });
  });
}

// Returns true if `docker image inspect <tag>` succeeds — i.e. the image
// already exists locally and no build is needed.
export async function imageExists(tag: string): Promise<boolean> {
  const { code } = await runDocker(["image", "inspect", tag]);
  return code === 0;
}

// Build the runner image. Tags with both `<name>:<hash>` (cache key) and
// `<name>:latest` (convenience for ad-hoc `docker run`).
async function buildImage(
  hash: string,
  context: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tag = runnerImageTag(hash);
  const { code, output } = await runDocker([
    "build",
    "-t",
    tag,
    "-t",
    `${RUNNER_IMAGE_NAME}:latest`,
    context,
  ]);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    error: `docker build exited with code ${code}: ${output.trim().slice(-500)}`,
  };
}

// Idempotent: ensures the runner image is built and tagged for the current
// Dockerfile. Concurrent callers share a single in-flight build.
//
// Returns when the image is ready (or when the build has failed). Status
// transitions are reflected in `getRunnerImageState()` so the UI can poll.
export async function ensureRunnerImage(db: Knex): Promise<RunnerImageState> {
  if (pendingBuild) {
    await pendingBuild;
    return getRunnerImageState();
  }

  pendingBuild = (async () => {
    state = {
      status: "checking",
      hash: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };

    let hash: string;
    let context: string;
    try {
      const resolved = resolveRunnerDockerfile();
      hash = computeDockerfileHash(resolved.dockerfile);
      context = resolved.context;
    } catch (err) {
      state = {
        ...state,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: (err as Error).message,
      };
      return;
    }

    state = { ...state, hash };

    const tag = runnerImageTag(hash);
    const exists = await imageExists(tag);
    if (exists) {
      state = {
        ...state,
        status: "ready",
        finishedAt: new Date().toISOString(),
      };
      try {
        await setSetting(db, RUNNER_IMAGE_HASH_KEY, hash);
      } catch (err) {
        console.error(
          "[imageBuilder] Failed to persist runner image hash:",
          (err as Error).message
        );
      }
      return;
    }

    state = { ...state, status: "building" };
    console.log(
      `[imageBuilder] Building runner image ${tag} (this may take a few minutes on first run).`
    );
    const result = await buildImage(hash, context);
    if (!result.ok) {
      state = {
        ...state,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: result.error,
      };
      console.error(`[imageBuilder] Build failed: ${result.error}`);
      return;
    }

    state = {
      ...state,
      status: "ready",
      finishedAt: new Date().toISOString(),
      error: null,
    };
    try {
      await setSetting(db, RUNNER_IMAGE_HASH_KEY, hash);
    } catch (err) {
      console.error(
        "[imageBuilder] Failed to persist runner image hash:",
        (err as Error).message
      );
    }
    console.log(`[imageBuilder] Runner image ready: ${tag}`);
  })();

  try {
    await pendingBuild;
  } finally {
    pendingBuild = null;
  }
  return getRunnerImageState();
}

// Read the last successfully built hash from app_settings. Used by API
// callers that want to compare current vs. last-known-good without triggering
// a build.
export async function getPersistedRunnerImageHash(
  db: Knex
): Promise<string | undefined> {
  return getSetting(db, RUNNER_IMAGE_HASH_KEY);
}
