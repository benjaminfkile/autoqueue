import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readFile, READ_FILE_BYTE_CAP } from "../src/services/repoTools";
import { Repo } from "../src/interfaces";

jest.mock("../src/db/repos", () => ({
  getRepoById: jest.fn(),
}));
import { getRepoById } from "../src/db/repos";

const baseRepo: Repo = {
  id: 1,
  owner: "acme",
  repo_name: "widgets",
  active: true,
  base_branch: "main",
  base_branch_parent: "main",
  require_pr: false,
  github_token: null,
  is_local_folder: true,
  local_path: "",
  on_failure: "halt_subtree",
  max_retries: 0,
  on_parent_child_fail: "ignore",
  ordering_mode: "sequential",
  clone_status: "ready",
  clone_error: null,
  created_at: new Date(),
};

describe("readFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-readfile-"));
    (getRepoById as jest.Mock).mockResolvedValue({
      ...baseRepo,
      local_path: tmpDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- AC #1073: Reads under 50KB succeed ---------------------------------
  describe("reads under 50KB succeed", () => {
    it("returns the full file contents for a small file (no range)", async () => {
      const body = "hello\nworld\n";
      fs.writeFileSync(path.join(tmpDir, "hi.txt"), body);
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "hi.txt",
      });
      expect(result).toEqual({ ok: true, content: body });
    });

    it("returns the full file contents for a file that is exactly at the byte cap", async () => {
      // Build content whose UTF-8 byte length equals the cap exactly.
      const body = "a".repeat(READ_FILE_BYTE_CAP);
      fs.writeFileSync(path.join(tmpDir, "atcap.txt"), body);
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "atcap.txt",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.content).toBe(body);
    });

    it("handles nested paths inside the repo", async () => {
      fs.mkdirSync(path.join(tmpDir, "src", "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "lib", "a.ts"), "// a\n");
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "src/lib/a.ts",
      });
      expect(result).toEqual({ ok: true, content: "// a\n" });
    });
  });

  // ---- AC #1074: Reads over 50KB without a range return an instructive error
  describe("reads over 50KB without a range return an instructive error", () => {
    it("refuses a file just one byte over the cap when no range is given", async () => {
      const body = "a".repeat(READ_FILE_BYTE_CAP + 1);
      fs.writeFileSync(path.join(tmpDir, "big.txt"), body);
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "big.txt",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // The error must (a) say the file is too big, (b) name the byte cap,
        // and (c) tell the model which tool args to retry with.
        expect(result.error).toMatch(/larger than/);
        expect(result.error).toContain(String(READ_FILE_BYTE_CAP));
        expect(result.error).toMatch(/start_line/);
        expect(result.error).toMatch(/end_line/);
      }
    });

    it("permits the same large file when a small range is requested", async () => {
      // 10k lines × ~10 bytes = ~100KB, comfortably over the 50KB cap.
      const lines = Array.from({ length: 10000 }, (_, i) => `line ${i + 1}`);
      const body = lines.join("\n") + "\n";
      // Sanity: ensure the file is over the cap so the test exercises the
      // "huge file but small slice" branch.
      expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(READ_FILE_BYTE_CAP);
      fs.writeFileSync(path.join(tmpDir, "big.txt"), body);
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "big.txt",
        start_line: 10,
        end_line: 12,
      });
      expect(result).toEqual({
        ok: true,
        content: "line 10\nline 11\nline 12",
      });
    });

    it("refuses a slice that is itself over the cap", async () => {
      const body = "a".repeat(READ_FILE_BYTE_CAP * 2);
      fs.writeFileSync(path.join(tmpDir, "big.txt"), body);
      // Whole file on a single line; ask for line 1..1 — the slice is the
      // whole file, which still exceeds the cap.
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "big.txt",
        start_line: 1,
        end_line: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/larger than/);
        expect(result.error).toContain(String(READ_FILE_BYTE_CAP));
        expect(result.error).toMatch(/narrower/);
      }
    });
  });

  // ---- AC #1075: Line-range slicing returns exact lines requested ---------
  describe("line-range slicing returns exact lines requested", () => {
    const sample = "a\nb\nc\nd\ne\n";

    beforeEach(() => {
      fs.writeFileSync(path.join(tmpDir, "abc.txt"), sample);
    });

    it("returns only the requested inclusive line range", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        start_line: 2,
        end_line: 4,
      });
      expect(result).toEqual({ ok: true, content: "b\nc\nd" });
    });

    it("returns a single line when start_line === end_line", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        start_line: 3,
        end_line: 3,
      });
      expect(result).toEqual({ ok: true, content: "c" });
    });

    it("treats omitted end_line as `to end of file`", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        start_line: 4,
      });
      // d, e — last line included; trailing newline preserved because the
      // source file ended with one.
      expect(result).toEqual({ ok: true, content: "d\ne\n" });
    });

    it("treats omitted start_line as line 1", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        end_line: 2,
      });
      expect(result).toEqual({ ok: true, content: "a\nb" });
    });

    it("clips end_line silently when it overshoots EOF", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        start_line: 4,
        end_line: 99,
      });
      expect(result).toEqual({ ok: true, content: "d\ne\n" });
    });

    it("returns empty content when start_line is past EOF", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        start_line: 50,
      });
      expect(result).toEqual({ ok: true, content: "" });
    });

    it("rejects end_line < start_line with an instructive error", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "abc.txt",
        start_line: 4,
        end_line: 2,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/end_line/);
    });

    it("works on files without a trailing newline", async () => {
      fs.writeFileSync(path.join(tmpDir, "nonl.txt"), "x\ny\nz");
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "nonl.txt",
        start_line: 2,
        end_line: 3,
      });
      expect(result).toEqual({ ok: true, content: "y\nz" });
    });
  });

  // ---- Input validation / error surfaces ---------------------------------
  describe("error surfaces", () => {
    it("returns an error (not a throw) for path traversal attempts", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "../etc/passwd",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/\.\./);
    });

    it("returns an error for missing files", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "does-not-exist.txt",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/);
    });

    it("returns an error when the path resolves to a directory", async () => {
      fs.mkdirSync(path.join(tmpDir, "subdir"));
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "subdir",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/regular file/);
    });

    it("rejects malformed input (missing path)", async () => {
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
      } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/path/);
    });

    it("rejects start_line < 1", async () => {
      fs.writeFileSync(path.join(tmpDir, "x.txt"), "a\n");
      const result = await readFile({} as never, "/unused", {
        repo_id: 1,
        path: "x.txt",
        start_line: 0,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/start_line/);
    });
  });
});
