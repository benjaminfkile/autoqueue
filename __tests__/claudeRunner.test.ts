import { EventEmitter } from "events";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runClaudeOnTask } from "../src/services/claudeRunner";
import { TaskPayload } from "../src/interfaces";

const spawnMock = spawn as unknown as jest.Mock;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
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
