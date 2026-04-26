import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  readFile,
  READ_FILE_BYTE_CAP,
  search,
  SEARCH_RESULT_CAP,
  disableRipgrepForTesting,
  resetRipgrepDetectionForTesting,
} from "../src/services/repoTools";
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

describe("search", () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grunt-search-"));
    (getRepoById as jest.Mock).mockResolvedValue({
      ...baseRepo,
      local_path: tmpDir,
    });
    // The host running these tests may or may not have ripgrep installed; the
    // unit tests are about the *contract* of search(), not the choice of
    // backend, so we pin the slower-but-portable node walker for both runs.
    // The two backends are exercised by the small ripgrep-backend block at
    // the bottom that flips detection back on.
    disableRipgrepForTesting();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetRipgrepDetectionForTesting();
  });

  // ---- AC #1076: cap and ordering ----------------------------------------
  describe("cap and ordering", () => {
    it("returns at most SEARCH_RESULT_CAP matches and flags truncation when more exist", async () => {
      // 150 files, each with one match. The walker should stop as soon as it
      // can prove more than 100 matches exist, slice down to 100, and report
      // truncated=true.
      for (let i = 0; i < 150; i++) {
        // Zero-pad the filename so alphabetical = numeric order; the assertion
        // below relies on this to know which 100 files we expect to see.
        const name = `f${String(i).padStart(3, "0")}.txt`;
        fs.writeFileSync(path.join(tmpDir, name), "needle\n");
      }
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches).toHaveLength(SEARCH_RESULT_CAP);
      expect(result.truncated).toBe(true);
      // The first 100 files in sort order are f000..f099.
      expect(result.matches[0].path).toBe("f000.txt");
      expect(result.matches[SEARCH_RESULT_CAP - 1].path).toBe("f099.txt");
    });

    it("does not flag truncation when the result set fits under the cap", async () => {
      fs.writeFileSync(path.join(tmpDir, "a.txt"), "needle\n");
      fs.writeFileSync(path.join(tmpDir, "b.txt"), "no match here\n");
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches).toHaveLength(1);
      expect(result.truncated).toBe(false);
    });

    it("sorts results by file path then by line number", async () => {
      // Three files with multiple matches each — the only way the result is
      // stable across runs is if the implementation sorts by (path, line).
      fs.writeFileSync(
        path.join(tmpDir, "b.txt"),
        ["needle one", "ignore", "needle two"].join("\n") + "\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "a.txt"),
        ["ignore", "needle three", "needle four"].join("\n") + "\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, "c.txt"),
        ["needle five"].join("\n") + "\n"
      );
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // a.txt before b.txt before c.txt; within each file, ascending line.
      expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
        "a.txt:2",
        "a.txt:3",
        "b.txt:1",
        "b.txt:3",
        "c.txt:1",
      ]);
    });

    it("returns the matched line text in each result", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "src.ts"),
        ["import x from 'y'", "const NEEDLE = 1", "export {}"].join("\n") + "\n"
      );
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "NEEDLE",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches).toEqual([
        { path: "src.ts", line: 2, text: "const NEEDLE = 1" },
      ]);
    });
  });

  // ---- AC #1077: .gitignore is respected ---------------------------------
  describe(".gitignore is respected", () => {
    it("skips paths matched by basename rules (node_modules, dist)", async () => {
      fs.writeFileSync(
        path.join(tmpDir, ".gitignore"),
        ["node_modules", "dist/", "*.log"].join("\n") + "\n"
      );
      // Real source file that should match.
      fs.writeFileSync(path.join(tmpDir, "real.ts"), "needle in source\n");
      // node_modules: the canonical noise directory the model must never see.
      fs.mkdirSync(path.join(tmpDir, "node_modules", "lodash"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "node_modules", "lodash", "index.js"),
        "needle in vendored code\n"
      );
      // dist/: build output, dir-only rule.
      fs.mkdirSync(path.join(tmpDir, "dist"));
      fs.writeFileSync(
        path.join(tmpDir, "dist", "bundle.js"),
        "needle in build output\n"
      );
      // *.log: glob rule that matches by basename.
      fs.writeFileSync(path.join(tmpDir, "debug.log"), "needle in log\n");

      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only the real source file may show up. None of the ignored paths
      // should leak into the result set.
      expect(result.matches.map((m) => m.path)).toEqual(["real.ts"]);
    });

    it("always skips the .git directory regardless of .gitignore contents", async () => {
      // No .gitignore at all — the .git directory must still be excluded so
      // we don't dump pack files / refs at the model.
      fs.writeFileSync(path.join(tmpDir, "real.ts"), "needle\n");
      fs.mkdirSync(path.join(tmpDir, ".git", "objects"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".git", "config"),
        "[remote] needle\n"
      );
      fs.writeFileSync(
        path.join(tmpDir, ".git", "objects", "pack.idx"),
        "needle\n"
      );

      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches.map((m) => m.path)).toEqual(["real.ts"]);
    });

    it("honours an anchored rule (leading slash) only at the repo root, not deeper", async () => {
      // `/build` matches a top-level `build` directory but not `src/build`.
      fs.writeFileSync(path.join(tmpDir, ".gitignore"), "/build\n");
      fs.mkdirSync(path.join(tmpDir, "build"));
      fs.writeFileSync(path.join(tmpDir, "build", "out.js"), "needle root\n");
      fs.mkdirSync(path.join(tmpDir, "src", "build"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "src", "build", "out.js"),
        "needle nested\n"
      );

      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches.map((m) => m.path)).toEqual([
        "src/build/out.js",
      ]);
    });
  });

  // ---- AC #1078: literal and regex modes -------------------------------
  describe("literal and regex modes", () => {
    it("regex mode interprets metacharacters", async () => {
      fs.writeFileSync(
        path.join(tmpDir, "code.ts"),
        ["const a = 1", "const b = 2", "let c = 3"].join("\n") + "\n"
      );
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "^const\\s+\\w",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only the two `const ...` lines, not `let ...`.
      expect(result.matches.map((m) => m.line)).toEqual([1, 2]);
      expect(result.matches.every((m) => m.path === "code.ts")).toBe(true);
    });

    it("literal mode treats metacharacters as literal text", async () => {
      // The pattern `a.b` should NOT match `axb` in literal mode (the `.` is
      // a regex wildcard in regex mode); it should only match `a.b`.
      fs.writeFileSync(
        path.join(tmpDir, "data.txt"),
        ["axb", "a.b", "ayb"].join("\n") + "\n"
      );
      const literal = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "a.b",
        literal: true,
      });
      expect(literal.ok).toBe(true);
      if (!literal.ok) return;
      expect(literal.matches.map((m) => m.text)).toEqual(["a.b"]);
    });

    it("regex mode matches metacharacter wildcards that literal mode does not", async () => {
      // Same fixture as above; regex mode treats `.` as `any character`, so
      // it matches all three lines. The contrast with the previous test
      // proves the two modes really do behave differently.
      fs.writeFileSync(
        path.join(tmpDir, "data.txt"),
        ["axb", "a.b", "ayb"].join("\n") + "\n"
      );
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "a.b",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches.map((m) => m.text)).toEqual([
        "axb",
        "a.b",
        "ayb",
      ]);
    });

    it("rejects an invalid regex with an instructive error (regex mode only)", async () => {
      fs.writeFileSync(path.join(tmpDir, "f.txt"), "x\n");
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "[unterminated",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid regex/);
    });

    it("does not validate the pattern as regex when literal=true", async () => {
      // The same `[unterminated` pattern that fails in regex mode must work
      // in literal mode — the brackets are just characters to find.
      fs.writeFileSync(
        path.join(tmpDir, "f.txt"),
        "before [unterminated tail\n"
      );
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "[unterminated",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches).toEqual([
        { path: "f.txt", line: 1, text: "before [unterminated tail" },
      ]);
    });
  });

  // ---- Path scoping & input validation ------------------------------------
  describe("path scoping and validation", () => {
    it("scopes the search to a subdirectory when `path` is provided", async () => {
      fs.writeFileSync(path.join(tmpDir, "top.txt"), "needle\n");
      fs.mkdirSync(path.join(tmpDir, "sub"));
      fs.writeFileSync(path.join(tmpDir, "sub", "inside.txt"), "needle\n");

      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        path: "sub",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only the file inside `sub/`. Result paths remain anchored at the
      // repo root so the model can pass them straight to read_file.
      expect(result.matches.map((m) => m.path)).toEqual(["sub/inside.txt"]);
    });

    it("rejects path traversal in the `path` field", async () => {
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "anything",
        path: "../etc",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/\.\./);
    });

    it("rejects a missing pattern", async () => {
      const result = await search({} as never, "/unused", {
        repo_id: 1,
      } as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/pattern/);
    });

    it("returns a not-found error when `path` does not exist", async () => {
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "x",
        path: "missing-dir",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/);
    });

    it("skips binary files (NUL byte sniffer) so the model never sees binary lines", async () => {
      // A small binary blob containing the word `needle` — a naive grep would
      // happily report it. The walker must skip it.
      const binary = Buffer.concat([
        Buffer.from("needle"),
        Buffer.from([0x00, 0x01, 0x02, 0x03]),
        Buffer.from("needle"),
      ]);
      fs.writeFileSync(path.join(tmpDir, "image.bin"), binary);
      fs.writeFileSync(path.join(tmpDir, "real.txt"), "needle here\n");

      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches.map((m) => m.path)).toEqual(["real.txt"]);
    });
  });

  // ---- Ripgrep backend (only runs when `rg` is on PATH) ---------------------
  // The two backends share the same external contract; this block proves the
  // ripgrep path also satisfies the AC's. Skipped on hosts without rg so the
  // suite stays portable.
  describe("ripgrep backend (when available)", () => {
    let rgInstalled: boolean;
    beforeAll(() => {
      try {
        const { spawnSync } = require("child_process") as typeof import("child_process");
        rgInstalled = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
      } catch {
        rgInstalled = false;
      }
    });

    beforeEach(() => {
      // Re-enable detection so search() picks the rg backend for these tests.
      resetRipgrepDetectionForTesting();
    });

    it("respects .gitignore via ripgrep just as the node walker does", async () => {
      if (!rgInstalled) return;
      fs.writeFileSync(
        path.join(tmpDir, ".gitignore"),
        ["node_modules", "dist/"].join("\n") + "\n"
      );
      fs.writeFileSync(path.join(tmpDir, "real.ts"), "needle here\n");
      fs.mkdirSync(path.join(tmpDir, "node_modules"));
      fs.writeFileSync(
        path.join(tmpDir, "node_modules", "vendored.js"),
        "needle in vendored\n"
      );
      // ripgrep also needs the directory to look like a repo for some
      // .gitignore behaviours (it walks up looking for the closest VCS
      // marker). Drop a stub `.git` so it treats tmpDir as the repo root.
      fs.mkdirSync(path.join(tmpDir, ".git"));

      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches.map((m) => m.path)).toEqual(["real.ts"]);
    });

    it("caps results at SEARCH_RESULT_CAP via ripgrep too", async () => {
      if (!rgInstalled) return;
      fs.mkdirSync(path.join(tmpDir, ".git"));
      for (let i = 0; i < 150; i++) {
        const name = `f${String(i).padStart(3, "0")}.txt`;
        fs.writeFileSync(path.join(tmpDir, name), "needle\n");
      }
      const result = await search({} as never, "/unused", {
        repo_id: 1,
        pattern: "needle",
        literal: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.matches.length).toBeLessThanOrEqual(SEARCH_RESULT_CAP);
      expect(result.truncated).toBe(true);
      // Sort order is the same as the node walker: alphabetical files first.
      expect(result.matches[0].path).toBe("f000.txt");
    });
  });
});
