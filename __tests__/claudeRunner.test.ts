import { EventEmitter } from "events";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseNotesFromOutput, runClaudeOnTask } from "../src/services/claudeRunner";
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
