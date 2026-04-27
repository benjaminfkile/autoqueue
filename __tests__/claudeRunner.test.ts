import { EventEmitter } from "events";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseNotesFromOutput,
  parseUsageFromOutput,
  runClaudeOnTask,
} from "../src/services/claudeRunner";
import { TaskPayload } from "../src/interfaces";

const spawnMock = spawn as unknown as jest.Mock;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: jest.fn(), end: jest.fn() };
  kill = jest.fn();
}

const samplePayload: TaskPayload = {
  task: {
    id: 42,
    title: "t",
    description: "",
    acceptanceCriteria: [],
    parent: null,
    siblings: [],
    notes: [],
  },
};

let tmpRoot: string;

beforeEach(() => {
  jest.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-runner-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe("runClaudeOnTask log capture", () => {
  it("writes stdout and stderr to the log file at the requested path", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const logFilePath = path.join(tmpRoot, "_logs", "task-42.log");

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      logFilePath,
    });

    child.stdout.emit("data", Buffer.from("hello "));
    child.stderr.emit("data", Buffer.from("world"));

    // Allow streams a tick to flush before close.
    await new Promise((r) => setImmediate(r));

    child.emit("close", 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(fs.existsSync(logFilePath)).toBe(true);
    const contents = fs.readFileSync(logFilePath, "utf8");
    expect(contents).toContain("hello ");
    expect(contents).toContain("world");
  });

  it("creates the parent directory if it doesn't exist", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const logFilePath = path.join(tmpRoot, "deep", "nested", "task-99.log");
    expect(fs.existsSync(path.dirname(logFilePath))).toBe(false);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      logFilePath,
    });

    child.stdout.emit("data", Buffer.from("ok"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await promise;

    expect(fs.existsSync(path.dirname(logFilePath))).toBe(true);
    expect(fs.existsSync(logFilePath)).toBe(true);
  });

  it("invokes onFirstByte exactly once on the very first stdout/stderr chunk", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const onFirstByte = jest.fn();
    const logFilePath = path.join(tmpRoot, "_logs", "task-1.log");

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      logFilePath,
      onFirstByte,
    });

    child.stdout.emit("data", Buffer.from("a"));
    child.stdout.emit("data", Buffer.from("b"));
    child.stderr.emit("data", Buffer.from("c"));

    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await promise;

    expect(onFirstByte).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onFirstByte if no output is produced", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const onFirstByte = jest.fn();
    const logFilePath = path.join(tmpRoot, "_logs", "task-2.log");

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      logFilePath,
      onFirstByte,
    });

    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await promise;

    expect(onFirstByte).not.toHaveBeenCalled();
  });

  it("works without a logFilePath (no file is written, no error)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.stdout.emit("data", Buffer.from("plain"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.output).toContain("plain");
  });

  it("the prompt passed to claude references the task.notes section so the agent reads it", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.emit("close", 0);
    await promise;

    // The last spawn argument is the prompt string passed to claude.
    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toMatch(/task\.notes/);
  });

  it("closes stdin when there are no secrets so the CLI doesn't pause 3s waiting for piped input", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    // Without an explicit stdin source, claude waits 3s for piped data
    // before printing a "no stdin received" warning and proceeding. With no
    // secrets to feed the entrypoint, we close stdin via 'ignore'.
    const opts = spawnMock.mock.calls[0][2] as { stdio?: unknown };
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not pass secret values via -e (would expose them in `docker inspect`)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      anthropicApiKey: "sk-ant-secret-value",
      ghPat: "ghp_secret_value",
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const joined = args.join(" ");
    // Secret values must never appear in argv. The flag-form `-e KEY=value`
    // would surface in `docker inspect` and is the bug we're guarding against.
    expect(joined).not.toContain("sk-ant-secret-value");
    expect(joined).not.toContain("ghp_secret_value");
    expect(args).not.toContain("ANTHROPIC_API_KEY");
    expect(args).not.toContain("GH_PAT");
  });

  it("mounts a tmpfs at /run/grunt-secrets and signals the entrypoint via -e GRUNT_SECRETS_FROM_STDIN=1", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      anthropicApiKey: "sk-ant-x",
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const tmpfsIdx = args.indexOf("--tmpfs");
    expect(tmpfsIdx).toBeGreaterThan(-1);
    // mode=01777 lets the unprivileged `node` user create the secrets file
    // even though docker mounts the tmpfs as root.
    expect(args[tmpfsIdx + 1]).toMatch(/^\/run\/grunt-secrets:/);
    expect(args[tmpfsIdx + 1]).toMatch(/mode=01777/);

    // The flag (not the value) is what tells the entrypoint to read stdin.
    const eIdx = args.indexOf("-e");
    expect(eIdx).toBeGreaterThan(-1);
    expect(args[eIdx + 1]).toBe("GRUNT_SECRETS_FROM_STDIN=1");
  });

  it("writes KEY=value lines for every provided secret to docker stdin", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      anthropicApiKey: "sk-ant-abc",
      ghPat: "ghp_def",
    });
    child.emit("close", 0);
    await promise;

    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const payload = child.stdin.write.mock.calls[0][0] as string;
    expect(payload).toContain("ANTHROPIC_API_KEY=sk-ant-abc");
    expect(payload).toContain("GH_PAT=ghp_def");
    // Final newline so the entrypoint's `read` loop captures the last line.
    expect(payload.endsWith("\n")).toBe(true);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);

    // With secrets, stdin must be a writable pipe.
    const opts = spawnMock.mock.calls[0][2] as { stdio?: unknown };
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("omits the tmpfs/-i/-e plumbing when no secrets are provided", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain("--tmpfs");
    expect(args).not.toContain("-i");
    expect(args).not.toContain("-e");
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Mount manifest — the docker invocation must bind-mount the host workDir at
  // /workspace :rw, set the container cwd to /workspace, run with --rm so
  // containers don't accumulate, and target the runner image's :latest tag.
  // Phase 9 explicitly scopes the runner to a single primary-repo bind mount;
  // no additional read-only or read-write mounts should be added here. These
  // tests freeze that contract so a future refactor can't quietly broaden the
  // mount surface (which would weaken the multi-repo-write story for Phase 10).
  // -------------------------------------------------------------------------
  it("bind-mounts the host workDir at /workspace with :rw mode", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    // The bind mount is the FIRST -v after `run`. We don't `args.indexOf("-v")`
    // on the value side because there is exactly one -v in the no-secrets path,
    // and the secrets path adds --tmpfs (not another -v) — so a future change
    // that swaps order or appends an unexpected -v will trip this assertion.
    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe(`${tmpRoot}:/workspace:rw`);
    // No second -v: Phase 9 mounts only the primary repo. Adding a second mount
    // here would silently expand the runner's blast radius.
    expect(args.lastIndexOf("-v")).toBe(vIdx);
  });

  it("sets the container working directory to /workspace via -w", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const wIdx = args.indexOf("-w");
    expect(wIdx).toBeGreaterThan(-1);
    expect(args[wIdx + 1]).toBe("/workspace");
  });

  it("invokes `docker run --rm` so containers do not accumulate after each task", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
  });

  it("targets the runner image at the :latest tag (refreshed by ensureRunnerImage on every build)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    // The image positional sits between the docker flags and the in-container
    // command. `claude` is the entrypoint we pass, so the image is the slot
    // immediately before it.
    const claudeIdx = args.indexOf("claude");
    expect(claudeIdx).toBeGreaterThan(0);
    expect(args[claudeIdx - 1]).toBe("grunt/runner:latest");
  });

  it("places the workspace bind mount before the image positional (docker flag/positional ordering)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    // docker run rejects flags that appear after the image positional. This
    // test catches a regression where someone reorders the args builder and
    // accidentally moves -v/-w past the image.
    const args = spawnMock.mock.calls[0][1] as string[];
    const vIdx = args.indexOf("-v");
    const wIdx = args.indexOf("-w");
    const imageIdx = args.indexOf("grunt/runner:latest");
    expect(vIdx).toBeLessThan(imageIdx);
    expect(wIdx).toBeLessThan(imageIdx);
  });

  it("uses the caller-supplied workDir verbatim (no path normalization or substitution)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    // A path with a trailing space-ish character would surface accidental
    // string concatenation bugs ("workDir + ':/workspace'") vs. proper
    // template-literal formation. We just need a host path distinct from the
    // ephemeral default to confirm the value flows through unchanged.
    const customDir = path.join(tmpRoot, "nested", "repo");
    fs.mkdirSync(customDir, { recursive: true });

    const promise = runClaudeOnTask({
      workDir: customDir,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const vIdx = args.indexOf("-v");
    expect(args[vIdx + 1]).toBe(`${customDir}:/workspace:rw`);
  });

  it("keeps the bind-mount manifest stable when secrets are also injected (mount + tmpfs coexist)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      anthropicApiKey: "sk-ant-x",
    });
    child.emit("close", 0);
    await promise;

    // Even with secrets in play, the workspace bind mount must remain the
    // single -v entry and continue to point at /workspace :rw — the secrets
    // path adds --tmpfs, not a second -v.
    const args = spawnMock.mock.calls[0][1] as string[];
    const vIdx = args.indexOf("-v");
    expect(vIdx).toBeGreaterThan(-1);
    expect(args[vIdx + 1]).toBe(`${tmpRoot}:/workspace:rw`);
    expect(args.lastIndexOf("-v")).toBe(vIdx);
    expect(args).toContain("--tmpfs");
  });

  // -------------------------------------------------------------------------
  // Phase 10: contextMounts — directly-linked repos are bind-mounted under
  // /context/<name>. Read-link mounts are :ro, write-link mounts are :rw. The
  // workspace bind mount is unchanged. Anything not in contextMounts must NOT
  // appear as a -v in the docker invocation.
  // -------------------------------------------------------------------------
  it("appends one -v per contextMount entry, in the order provided", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      contextMounts: [
        { hostPath: "/repos/acme/lib-a", containerPath: "/context/lib-a", mode: "ro" },
        { hostPath: "/repos/acme/lib-b", containerPath: "/context/lib-b", mode: "rw" },
      ],
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const vIndices: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") vIndices.push(i);
    }
    // Three -v total: primary + two context mounts.
    expect(vIndices).toHaveLength(3);
    expect(args[vIndices[0] + 1]).toBe(`${tmpRoot}:/workspace:rw`);
    expect(args[vIndices[1] + 1]).toBe("/repos/acme/lib-a:/context/lib-a:ro");
    expect(args[vIndices[2] + 1]).toBe("/repos/acme/lib-b:/context/lib-b:rw");
  });

  it("places every context -v before the image positional (docker won't accept flags after it)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      contextMounts: [
        { hostPath: "/repos/acme/lib-a", containerPath: "/context/lib-a", mode: "ro" },
      ],
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const imageIdx = args.indexOf("grunt/runner:latest");
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-v") {
        expect(i).toBeLessThan(imageIdx);
      }
    }
  });

  it("emits exactly one -v (the primary) when contextMounts is omitted — Phase 10 is opt-in via the manifest", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const vIndices = args.reduce<number[]>((acc, a, i) => (a === "-v" ? [...acc, i] : acc), []);
    expect(vIndices).toHaveLength(1);
    expect(args[vIndices[0] + 1]).toBe(`${tmpRoot}:/workspace:rw`);
  });

  it("emits exactly one -v (the primary) when contextMounts is an empty array (no links → no extra mounts)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      contextMounts: [],
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const vIndices = args.reduce<number[]>((acc, a, i) => (a === "-v" ? [...acc, i] : acc), []);
    expect(vIndices).toHaveLength(1);
  });

  it("renders read-link mounts as :ro (the host repo is not writable from inside the container)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      contextMounts: [
        { hostPath: "/repos/acme/readonly", containerPath: "/context/readonly", mode: "ro" },
      ],
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const vEntries = args
      .map((a, i) => (a === "-v" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);
    expect(vEntries).toContain("/repos/acme/readonly:/context/readonly:ro");
  });

  it("renders write-link mounts as :rw (the agent can edit the linked repo)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      contextMounts: [
        { hostPath: "/repos/acme/writable", containerPath: "/context/writable", mode: "rw" },
      ],
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const vEntries = args
      .map((a, i) => (a === "-v" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);
    expect(vEntries).toContain("/repos/acme/writable:/context/writable:rw");
  });

  it("coexists with the secrets tmpfs (mount + tmpfs both present, image positional still last among flags)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      anthropicApiKey: "sk-ant-x",
      contextMounts: [
        { hostPath: "/repos/acme/lib", containerPath: "/context/lib", mode: "rw" },
      ],
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--tmpfs");
    const vEntries = args
      .map((a, i) => (a === "-v" ? args[i + 1] : null))
      .filter((v): v is string => v !== null);
    // Two -v entries: primary + one context. The tmpfs is a separate flag.
    expect(vEntries).toEqual([
      `${tmpRoot}:/workspace:rw`,
      "/repos/acme/lib:/context/lib:rw",
    ]);
  });

  // -------------------------------------------------------------------------
  // Stdout capture — task output drives notes parsing, usage extraction, and
  // the persisted log file. Verify chunked, interleaved stdout/stderr is
  // captured into the result.output buffer in arrival order.
  // -------------------------------------------------------------------------
  it("captures interleaved stdout and stderr chunks into result.output in arrival order", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.stdout.emit("data", Buffer.from("chunk-1 "));
    child.stderr.emit("data", Buffer.from("warn-A "));
    child.stdout.emit("data", Buffer.from("chunk-2 "));
    child.stderr.emit("data", Buffer.from("warn-B"));

    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const result = await promise;

    // Stdout and stderr are merged into a single buffer because both feed the
    // notes/usage parsers, and the agent CLI emits its JSON envelope on stdout
    // but warnings on stderr — losing either would break downstream parsing.
    expect(result.output).toBe("chunk-1 warn-A chunk-2 warn-B");
  });

  it("captures stdout produced AFTER the first byte was already seen (cumulative buffering)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const onFirstByte = jest.fn();
    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      onFirstByte,
    });

    child.stdout.emit("data", Buffer.from("first"));
    child.stdout.emit("data", Buffer.from(" second"));
    child.stdout.emit("data", Buffer.from(" third"));

    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const result = await promise;

    // The handler stops invoking onFirstByte after the first chunk; this test
    // catches a regression where someone short-circuits the data handler
    // entirely after firstByteSeen is true and stops appending to `output`.
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("first second third");
  });

  it("returns success=false but still surfaces captured output when the docker child errors out before close", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.stdout.emit("data", Buffer.from("partial output before crash\n"));
    await new Promise((r) => setImmediate(r));
    // 'error' fires when spawn itself fails (e.g. ENOENT on docker). The
    // existing 'docker not installed' coverage in the runner tests is
    // implicit; this test makes the contract explicit at the runner layer.
    child.emit("error", new Error("spawn docker ENOENT"));
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.output).toContain("partial output before crash");
    expect(result.output).toContain("spawn docker ENOENT");
    expect(result.notes).toEqual([]);
    expect(result.usage).toBeNull();
  });

  it("the prompt documents the NOTES_TO_SAVE protocol so the agent knows how to emit notes", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    // The protocol block + the JSON-shape contract + the visibility enum must
    // all be present so the agent has a complete spec to emit against.
    expect(prompt).toContain("<NOTES_TO_SAVE>");
    expect(prompt).toContain("</NOTES_TO_SAVE>");
    expect(prompt).toMatch(/visibility/);
    expect(prompt).toMatch(/content/);
    expect(prompt).toMatch(/self|siblings|descendants|ancestors|all/);
  });

  it("returns parsed notes from the agent's NOTES_TO_SAVE block on the result object", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.stdout.emit(
      "data",
      Buffer.from(
        'I did the thing.\n<NOTES_TO_SAVE>\n[{"visibility":"siblings","tags":["context"],"content":"watch the order"}]\n</NOTES_TO_SAVE>\nDone.'
      )
    );
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.notes).toEqual([
      { visibility: "siblings", tags: ["context"], content: "watch the order" },
    ]);
  });

  it("returns an empty notes array when the agent emits no NOTES_TO_SAVE block", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.stdout.emit("data", Buffer.from("plain output"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const result = await promise;

    expect(result.notes).toEqual([]);
  });

  it("preserves log file across child close (file persists after task completion)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const logFilePath = path.join(tmpRoot, "_logs", "task-77.log");

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
      logFilePath,
    });

    child.stdout.emit("data", Buffer.from("persisted"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 1);
    await promise;

    // After completion, the file is still readable.
    expect(fs.existsSync(logFilePath)).toBe(true);
    expect(fs.readFileSync(logFilePath, "utf8")).toContain("persisted");
  });
});

// ---------------------------------------------------------------------------
// parseNotesFromOutput — the structured agent-output protocol for note writing.
// The agent emits one or more <NOTES_TO_SAVE>...</NOTES_TO_SAVE> blocks; each
// block is a JSON array of {content, visibility, tags?} objects. The parser is
// defensive: malformed blocks are skipped (logged), not fatal — a bad note
// block must not derail the whole task.
// ---------------------------------------------------------------------------
describe("parseNotesFromOutput", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("returns [] on output with no NOTES_TO_SAVE block", () => {
    expect(parseNotesFromOutput("hello world")).toEqual([]);
    expect(parseNotesFromOutput("")).toEqual([]);
  });

  it("parses a single NOTES_TO_SAVE block containing one note", () => {
    const out = `prelude
<NOTES_TO_SAVE>
[{"visibility":"siblings","content":"hi"}]
</NOTES_TO_SAVE>
trailing`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "siblings", content: "hi" },
    ]);
  });

  it("preserves the optional tags field when present", () => {
    const out = `<NOTES_TO_SAVE>[{"visibility":"all","tags":["a","b"],"content":"x"}]</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "all", tags: ["a", "b"], content: "x" },
    ]);
  });

  it("omits the tags field when not provided (so callers can default it downstream)", () => {
    const out = `<NOTES_TO_SAVE>[{"visibility":"self","content":"x"}]</NOTES_TO_SAVE>`;
    const notes = parseNotesFromOutput(out);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({ visibility: "self", content: "x" });
    expect("tags" in notes[0]).toBe(false);
  });

  it("supports multiple NOTES_TO_SAVE blocks in the same output (concatenated, in order)", () => {
    const out = `<NOTES_TO_SAVE>[{"visibility":"siblings","content":"a"}]</NOTES_TO_SAVE>
middle
<NOTES_TO_SAVE>[{"visibility":"all","content":"b"}]</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "siblings", content: "a" },
      { visibility: "all", content: "b" },
    ]);
  });

  it("supports a single block carrying multiple notes", () => {
    const out = `<NOTES_TO_SAVE>
[
  {"visibility":"siblings","content":"a"},
  {"visibility":"descendants","content":"b","tags":["t"]}
]
</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "siblings", content: "a" },
      { visibility: "descendants", tags: ["t"], content: "b" },
    ]);
  });

  it("skips blocks whose body is not valid JSON (the rest of the output still parses)", () => {
    const out = `<NOTES_TO_SAVE>not json</NOTES_TO_SAVE>
<NOTES_TO_SAVE>[{"visibility":"all","content":"ok"}]</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "all", content: "ok" },
    ]);
  });

  it("skips blocks whose body is JSON but not an array", () => {
    const out = `<NOTES_TO_SAVE>{"visibility":"all","content":"oops"}</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([]);
  });

  it("skips note entries with missing/empty content", () => {
    const out = `<NOTES_TO_SAVE>[
      {"visibility":"all"},
      {"visibility":"all","content":""},
      {"visibility":"all","content":"keeper"}
    ]</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "all", content: "keeper" },
    ]);
  });

  it("skips note entries with an invalid visibility (must match the NoteVisibility enum)", () => {
    const out = `<NOTES_TO_SAVE>[
      {"visibility":"public","content":"x"},
      {"visibility":"siblings","content":"keeper"}
    ]</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "siblings", content: "keeper" },
    ]);
  });

  it("skips note entries whose tags is not a string array", () => {
    const out = `<NOTES_TO_SAVE>[
      {"visibility":"all","content":"x","tags":"oops"},
      {"visibility":"all","content":"y","tags":[1,2,3]},
      {"visibility":"all","content":"keeper","tags":["ok"]}
    ]</NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([
      { visibility: "all", tags: ["ok"], content: "keeper" },
    ]);
  });

  it("ignores empty NOTES_TO_SAVE blocks", () => {
    const out = `<NOTES_TO_SAVE></NOTES_TO_SAVE>
<NOTES_TO_SAVE>   </NOTES_TO_SAVE>`;
    expect(parseNotesFromOutput(out)).toEqual([]);
  });

  it("accepts every visibility enum value (self, siblings, descendants, ancestors, all)", () => {
    const out = `<NOTES_TO_SAVE>[
      {"visibility":"self","content":"a"},
      {"visibility":"siblings","content":"b"},
      {"visibility":"descendants","content":"c"},
      {"visibility":"ancestors","content":"d"},
      {"visibility":"all","content":"e"}
    ]</NOTES_TO_SAVE>`;
    const notes = parseNotesFromOutput(out);
    expect(notes.map((n) => n.visibility)).toEqual([
      "self",
      "siblings",
      "descendants",
      "ancestors",
      "all",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseUsageFromOutput — extract Anthropic SDK token usage from the agent's
// raw output (`--output-format stream-json` and `--output-format json` shapes).
// Token tracking depends on this; an undetected usage block means no
// task_usage row is written, so the parser must accept both formats and reject
// noise (notes blocks, plain text, malformed JSON).
// ---------------------------------------------------------------------------
describe("parseUsageFromOutput", () => {
  it("returns null when output is empty or has no JSON-shaped lines", () => {
    expect(parseUsageFromOutput("")).toBeNull();
    expect(parseUsageFromOutput("just plain text\nnot json at all")).toBeNull();
  });

  it("returns null when the output contains only a NOTES_TO_SAVE block (no usage info)", () => {
    const out = `<NOTES_TO_SAVE>[{"visibility":"all","content":"x"}]</NOTES_TO_SAVE>`;
    expect(parseUsageFromOutput(out)).toBeNull();
  });

  it("parses the top-level usage envelope produced by --output-format json", () => {
    const out = JSON.stringify({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 1000,
      },
    });
    expect(parseUsageFromOutput(out)).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 1000,
    });
  });

  it("extracts usage from message.usage in stream-json assistant events", () => {
    const out = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    });
    expect(parseUsageFromOutput(out)).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("sums usage across multiple JSON event lines (multi-turn run aggregates correctly)", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 50,
            output_tokens: 75,
            cache_creation_input_tokens: 25,
            cache_read_input_tokens: 500,
          },
        },
      }),
    ].join("\n");

    expect(parseUsageFromOutput(lines)).toEqual({
      input_tokens: 150,
      output_tokens: 275,
      cache_creation_input_tokens: 25,
      cache_read_input_tokens: 500,
    });
  });

  it("ignores JSON lines that don't contain a usage block (plumbing events, plain text, etc.)", () => {
    const out = [
      JSON.stringify({ type: "system", subtype: "init" }),
      "plain text mixed in",
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
    ].join("\n");

    expect(parseUsageFromOutput(out)).toEqual({
      input_tokens: 5,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("ignores malformed JSON lines without breaking parsing of valid ones afterwards", () => {
    const out = [
      "{ this is broken JSON",
      JSON.stringify({
        usage: {
          input_tokens: 7,
          output_tokens: 14,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    ].join("\n");

    expect(parseUsageFromOutput(out)).toEqual({
      input_tokens: 7,
      output_tokens: 14,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("treats missing or non-numeric fields as zero (so a partial usage block doesn't NaN the totals)", () => {
    const out = JSON.stringify({
      usage: {
        input_tokens: 10,
        // output_tokens missing
        cache_creation_input_tokens: "not a number",
        cache_read_input_tokens: -5, // negative is rejected → treated as 0
      },
    });
    expect(parseUsageFromOutput(out)).toEqual({
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("returns null when a usage block exists but every field is zero (avoids inserting all-zero rows)", () => {
    const out = JSON.stringify({
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(parseUsageFromOutput(out)).toBeNull();
  });

  it("ignores JSON arrays at the top level (so a NOTES_TO_SAVE block's inner JSON array isn't misread as usage)", () => {
    const out = `[{"usage":{"input_tokens":10,"output_tokens":20}}]`;
    expect(parseUsageFromOutput(out)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runClaudeOnTask — integration: usage is extracted from the agent's output
// and surfaced on the result alongside notes.
// ---------------------------------------------------------------------------
describe("runClaudeOnTask usage extraction", () => {
  it("returns the parsed usage on the result when the agent emits a stream-json usage block", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    const usageEvent = JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000,
        },
      },
    });
    child.stdout.emit("data", Buffer.from(usageEvent + "\n"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1000,
    });
  });

  it("returns usage: null when the agent emits no JSON usage block (plain text only)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    child.stdout.emit("data", Buffer.from("plain text agent output"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const result = await promise;

    expect(result.usage).toBeNull();
  });

  it("returns usage even when the agent run failed (failed runs cost tokens too)", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });

    const usageEvent = JSON.stringify({
      usage: {
        input_tokens: 5,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    child.stdout.emit("data", Buffer.from(usageEvent + "\n"));
    await new Promise((r) => setImmediate(r));
    child.emit("close", 1); // non-zero exit
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.usage).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it("invokes the claude CLI with --output-format stream-json --verbose so usage events are emitted", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runClaudeOnTask({
      workDir: tmpRoot,
      taskPayload: samplePayload,
    });
    child.emit("close", 0);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--output-format");
    expect(args.indexOf("stream-json")).toBe(args.indexOf("--output-format") + 1);
    expect(args).toContain("--verbose");
    // Prompt is still last.
    expect(args[args.length - 1]).toMatch(/task\.notes/);
  });
});
