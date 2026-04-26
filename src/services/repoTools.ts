import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { Knex } from "knex";
import { PathTraversalError, resolveRepoPath } from "./repoPath";

// Hard cap on the bytes a single read_file response may return. Sized so the
// model's tool_result stays well below the per-message context budget; large
// files must be sliced via start_line/end_line.
export const READ_FILE_BYTE_CAP = 50 * 1024;

// Hard cap on how many results `search` may return in a single response. The
// model is told to narrow its query if it hits this cap, so the cap doubles as
// a back-pressure signal — see SEARCH_TOOL.description in chatService.ts.
export const SEARCH_RESULT_CAP = 100;

export interface ReadFileInput {
  repo_id: number;
  path: string;
  start_line?: number;
  end_line?: number;
}

export type ReadFileResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

// Implements the `read_file` tool from chatService.ts. The caller (the chat
// tool-use loop) hands us the raw input the model produced; we validate it,
// route the path through the audited resolveRepoPath, and return either the
// requested slice as text or an error string the model can read and act on.
//
// Failure modes we surface as `error` rather than throwing, so the tool-use
// loop can ship them back to the model unchanged:
//   - bad input shape (missing/invalid fields, end_line < start_line)
//   - path traversal attempts (PathTraversalError from resolveRepoPath)
//   - file does not exist / is not a regular file
//   - response would exceed READ_FILE_BYTE_CAP
//
// Throwing is reserved for things the model cannot fix — DB lookup failures,
// repo-not-found, etc. — which the loop will translate into a chat-level error.
export async function readFile(
  db: Knex,
  reposPath: string,
  input: ReadFileInput
): Promise<ReadFileResult> {
  const validation = validateInput(input);
  if (!validation.ok) return { ok: false, error: validation.error };
  const { repo_id, path: relPath, start_line, end_line } = validation.value;

  let absolutePath: string;
  try {
    absolutePath = await resolveRepoPath(db, reposPath, repo_id, relPath);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: `file not found: ${relPath}` };
    }
    return { ok: false, error: `read_file failed: ${(err as Error).message}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `not a regular file: ${relPath}` };
  }

  const hasRange = start_line !== undefined || end_line !== undefined;

  // Fast path — refuse large files up front when no range was given so we do
  // not slurp megabytes off disk just to throw them away. The error names the
  // exact tool args the model needs to retry with.
  if (!hasRange && stat.size > READ_FILE_BYTE_CAP) {
    return {
      ok: false,
      error:
        `file is ${stat.size} bytes, larger than the ${READ_FILE_BYTE_CAP}-byte ` +
        `read_file response cap. Re-call read_file with start_line and end_line ` +
        `to read a slice (1-indexed, inclusive).`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(absolutePath);
  } catch (err) {
    return { ok: false, error: `read_file failed: ${(err as Error).message}` };
  }
  const text = buffer.toString("utf8");

  const content = hasRange ? sliceLines(text, start_line, end_line) : text;

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > READ_FILE_BYTE_CAP) {
    return {
      ok: false,
      error:
        `requested slice is ${bytes} bytes, larger than the ${READ_FILE_BYTE_CAP}-byte ` +
        `read_file response cap. Re-call read_file with a narrower start_line/end_line range.`,
    };
  }

  return { ok: true, content };
}

interface ValidatedInput {
  repo_id: number;
  path: string;
  start_line?: number;
  end_line?: number;
}

function validateInput(
  input: ReadFileInput | undefined | null
): { ok: true; value: ValidatedInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "read_file: input must be an object" };
  }
  if (typeof input.repo_id !== "number" || !Number.isInteger(input.repo_id) || input.repo_id < 1) {
    return { ok: false, error: "read_file: repo_id must be a positive integer" };
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    return { ok: false, error: "read_file: path must be a non-empty string" };
  }
  if (input.start_line !== undefined) {
    if (!Number.isInteger(input.start_line) || input.start_line < 1) {
      return { ok: false, error: "read_file: start_line must be a positive integer" };
    }
  }
  if (input.end_line !== undefined) {
    if (!Number.isInteger(input.end_line) || input.end_line < 1) {
      return { ok: false, error: "read_file: end_line must be a positive integer" };
    }
  }
  if (
    input.start_line !== undefined &&
    input.end_line !== undefined &&
    input.end_line < input.start_line
  ) {
    return { ok: false, error: "read_file: end_line must be >= start_line" };
  }
  return {
    ok: true,
    value: {
      repo_id: input.repo_id,
      path: input.path,
      start_line: input.start_line,
      end_line: input.end_line,
    },
  };
}

// Slice `text` to the requested 1-indexed inclusive line range. Out-of-range
// requests clip silently to what the file actually contains (start beyond EOF
// → empty string; end beyond EOF → up to EOF), which mirrors how the model
// would expect a "give me lines N..M" call to behave when N..M overshoots.
function sliceLines(
  text: string,
  startLine: number | undefined,
  endLine: number | undefined
): string {
  // split(/\r?\n/) on a file that ends with a newline produces a trailing
  // empty entry; drop it so line counts match the conventional "lines in the
  // file" interpretation a user would have when reading in an editor.
  const endsWithNewline = text.endsWith("\n");
  const parts = text.split(/\r?\n/);
  const lines = endsWithNewline ? parts.slice(0, -1) : parts;

  const startIdx = (startLine ?? 1) - 1;
  if (startIdx >= lines.length) return "";
  const endIdx = endLine !== undefined ? Math.min(endLine, lines.length) : lines.length;

  const sliced = lines.slice(startIdx, endIdx).join("\n");
  // Re-attach a trailing newline only when we included the file's last line
  // and the original file ended with one — otherwise we'd be inventing one.
  if (endsWithNewline && endIdx === lines.length && sliced.length > 0) {
    return sliced + "\n";
  }
  return sliced;
}

// ---- search ---------------------------------------------------------------
// Implements the `search` tool. Two backends share one entry point:
//   1. ripgrep (`rg`), if it is on PATH — fast, .gitignore-aware out of the
//      box, and the production happy path on any reasonable dev/build host.
//   2. A node-based recursive walker, as a fallback when `rg` is not
//      available. The walker mirrors ripgrep's contract closely enough for
//      the planning chat: it skips `.git` and any path matched by the repo
//      root's `.gitignore`, and returns the same {path, line, text} tuples.
//
// Both paths cap their result set at SEARCH_RESULT_CAP and surface a
// `truncated` flag so the model knows to narrow the query when it hits the
// cap. Results are sorted by (path, line) regardless of which backend
// produced them, so the response is stable across runs.

export interface SearchInput {
  repo_id: number;
  pattern: string;
  path?: string;
  literal?: boolean;
}

export interface SearchMatch {
  path: string; // forward-slash, relative to repo root
  line: number; // 1-indexed
  text: string; // matched line, trailing newline stripped
}

export type SearchResult =
  | { ok: true; matches: SearchMatch[]; truncated: boolean }
  | { ok: false; error: string };

// Module-level cache of the `rg --version` probe so we don't fork a child for
// every search call. Reset via `resetRipgrepDetectionForTesting` in tests.
let ripgrepAvailability: boolean | null = null;
let ripgrepDisabledForTesting = false;

export function disableRipgrepForTesting(): void {
  ripgrepDisabledForTesting = true;
  ripgrepAvailability = false;
}

export function resetRipgrepDetectionForTesting(): void {
  ripgrepDisabledForTesting = false;
  ripgrepAvailability = null;
}

function isRipgrepAvailable(): boolean {
  if (ripgrepDisabledForTesting) return false;
  if (ripgrepAvailability !== null) return ripgrepAvailability;
  try {
    const result = spawnSync("rg", ["--version"], { stdio: "ignore" });
    ripgrepAvailability = result.status === 0;
  } catch {
    ripgrepAvailability = false;
  }
  return ripgrepAvailability;
}

export async function search(
  db: Knex,
  reposPath: string,
  input: SearchInput
): Promise<SearchResult> {
  const validation = validateSearchInput(input);
  if (!validation.ok) return { ok: false, error: validation.error };
  const { repo_id, pattern, path: scope, literal } = validation.value;

  let rootDir: string;
  let scopeDir: string;
  try {
    rootDir = await resolveRepoPath(db, reposPath, repo_id, "");
    scopeDir = scope
      ? await resolveRepoPath(db, reposPath, repo_id, scope)
      : rootDir;
  } catch (err) {
    if (err instanceof PathTraversalError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  let scopeStat: fs.Stats;
  try {
    scopeStat = await fs.promises.stat(scopeDir);
  } catch {
    return { ok: false, error: `search path not found: ${scope ?? "."}` };
  }
  if (!scopeStat.isDirectory()) {
    return {
      ok: false,
      error: `search path is not a directory: ${scope ?? "."}`,
    };
  }

  // Validate the regex now (cheap, JS engine) so we surface a useful error
  // before we fork ripgrep or descend into the walker. Literal mode skips
  // this — the pattern is taken verbatim, so any string is fine.
  if (!literal) {
    try {
      new RegExp(pattern);
    } catch (err) {
      return { ok: false, error: `invalid regex: ${(err as Error).message}` };
    }
  }

  if (isRipgrepAvailable()) {
    try {
      const matches = await runRipgrep(rootDir, scopeDir, pattern, !!literal);
      return finalizeSearchMatches(matches);
    } catch {
      // Fall through to the node walker. Any rg failure (binary missing on
      // PATH at exec time, broken pipe after we killed it for hitting the
      // cap, etc.) is treated as "rg not usable" and we silently retry with
      // the fallback so the model still gets results.
    }
  }
  const matches = await runNodeSearch(rootDir, scopeDir, pattern, !!literal);
  return finalizeSearchMatches(matches);
}

function finalizeSearchMatches(matches: SearchMatch[]): SearchResult {
  matches.sort((a, b) => {
    if (a.path === b.path) return a.line - b.line;
    return a.path < b.path ? -1 : 1;
  });
  const truncated = matches.length > SEARCH_RESULT_CAP;
  return {
    ok: true,
    matches: truncated ? matches.slice(0, SEARCH_RESULT_CAP) : matches,
    truncated,
  };
}

interface ValidatedSearchInput {
  repo_id: number;
  pattern: string;
  path?: string;
  literal?: boolean;
}

function validateSearchInput(
  input: SearchInput | undefined | null
):
  | { ok: true; value: ValidatedSearchInput }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "search: input must be an object" };
  }
  if (
    typeof input.repo_id !== "number" ||
    !Number.isInteger(input.repo_id) ||
    input.repo_id < 1
  ) {
    return { ok: false, error: "search: repo_id must be a positive integer" };
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return { ok: false, error: "search: pattern must be a non-empty string" };
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return { ok: false, error: "search: path must be a string when provided" };
  }
  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    return {
      ok: false,
      error: "search: literal must be a boolean when provided",
    };
  }
  return {
    ok: true,
    value: {
      repo_id: input.repo_id,
      pattern: input.pattern,
      path: input.path,
      literal: input.literal,
    },
  };
}

// ---- ripgrep backend -----------------------------------------------------
// We pipe through `--json` for unambiguous parsing (paths that contain `:`
// would break `--vimgrep`-style output) and `--sort path` so that the order
// in which we collect events is already (path, line). With deterministic
// order we can stop as soon as we have SEARCH_RESULT_CAP+1 matches and still
// know we have the smallest 100 by sort key.
function runRipgrep(
  rootDir: string,
  scopeDir: string,
  pattern: string,
  literal: boolean
): Promise<SearchMatch[]> {
  return new Promise<SearchMatch[]>((resolve, reject) => {
    const args = [
      "--json",
      "--sort",
      "path",
      ...(literal ? ["--fixed-strings"] : []),
      "-e",
      pattern,
      ".",
    ];
    const child = spawn("rg", args, {
      cwd: scopeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const matches: SearchMatch[] = [];
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let killed = false;
    let settled = false;
    const settle = (
      action: () => void
    ) => {
      if (settled) return;
      settled = true;
      action();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        const m = parseRipgrepJsonLine(line, rootDir, scopeDir);
        if (m) matches.push(m);
        if (matches.length > SEARCH_RESULT_CAP && !killed) {
          killed = true;
          child.kill("SIGTERM");
          break;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      settle(() => reject(err));
    });

    child.on("close", (code) => {
      // Exit codes from ripgrep:
      //   0 — matches found
      //   1 — no matches (not an error for our purposes)
      //   2 — actual error (bad regex, IO failure, etc.)
      // When we kill the child after hitting the cap, code may be null with
      // signal SIGTERM; treat that as success since we have what we needed.
      if (killed || code === 0 || code === 1 || code === null) {
        settle(() => resolve(matches));
        return;
      }
      settle(() =>
        reject(new Error(`ripgrep exited ${code}: ${stderrBuffer.trim()}`))
      );
    });
  });
}

interface RgJsonEvent {
  type?: string;
  data?: {
    path?: { text?: string; bytes?: string };
    lines?: { text?: string; bytes?: string };
    line_number?: number;
  };
}

function parseRipgrepJsonLine(
  line: string,
  rootDir: string,
  scopeDir: string
): SearchMatch | null {
  if (line.length === 0) return null;
  let event: RgJsonEvent;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "match" || !event.data) return null;
  const filePath = event.data.path?.text;
  const text = event.data.lines?.text;
  const lineNumber = event.data.line_number;
  if (
    typeof filePath !== "string" ||
    typeof text !== "string" ||
    typeof lineNumber !== "number"
  ) {
    return null;
  }
  // ripgrep paths are relative to its cwd (the scopeDir). Re-anchor them to
  // the repo root so the model always sees a path it can pass back to
  // read_file unchanged.
  const absoluteFile = path.resolve(scopeDir, filePath);
  const relativeToRoot = path
    .relative(rootDir, absoluteFile)
    .split(path.sep)
    .join("/");
  return {
    path: relativeToRoot,
    line: lineNumber,
    text: text.replace(/\r?\n$/, ""),
  };
}

// ---- node-based fallback walker ------------------------------------------
// A best-effort port of the ripgrep contract for hosts without `rg`. It is
// intentionally narrow: it understands the `.gitignore` features that show up
// in real repos (basename matches, dir-only `foo/`, simple globs with `*` /
// `**`) and it always skips `.git` regardless of what `.gitignore` says.
// Negation rules (`!pattern`) and nested per-directory `.gitignore` files are
// not supported; the planning chat does not need them, and the production
// path uses ripgrep anyway.

interface IgnoreRule {
  regex: RegExp;
  dirOnly: boolean;
  basenameOnly: boolean;
}

async function runNodeSearch(
  rootDir: string,
  scopeDir: string,
  pattern: string,
  literal: boolean
): Promise<SearchMatch[]> {
  const rules = await loadGitignoreRules(rootDir);
  const matcher = literal
    ? buildLiteralMatcher(pattern)
    : new RegExp(pattern);
  const matches: SearchMatch[] = [];
  await walk(scopeDir, rootDir, rules, matcher, matches);
  return matches;
}

function buildLiteralMatcher(pattern: string): RegExp {
  // Escape every regex metacharacter so the pattern is treated as a literal
  // substring search. Faster than RegExp + escape for short patterns and
  // keeps the matcher API uniform with the regex path.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped);
}

async function walk(
  dir: string,
  rootDir: string,
  rules: IgnoreRule[],
  matcher: RegExp,
  matches: SearchMatch[]
): Promise<void> {
  if (matches.length > SEARCH_RESULT_CAP) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort to give a stable (path, line) result order without a separate sort
  // pass at the end. Also lets us stop early once we have enough results.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (matches.length > SEARCH_RESULT_CAP) return;
    const absChild = path.join(dir, entry.name);
    const relFromRoot = path
      .relative(rootDir, absChild)
      .split(path.sep)
      .join("/");
    if (isIgnoredPath(relFromRoot, entry.isDirectory(), rules)) continue;

    if (entry.isDirectory()) {
      await walk(absChild, rootDir, rules, matcher, matches);
    } else if (entry.isFile()) {
      await scanFile(absChild, relFromRoot, matcher, matches);
    }
    // Symlinks and other special files are skipped — we never follow links
    // out of the repo and don't search devices/sockets.
  }
}

async function scanFile(
  absPath: string,
  relPath: string,
  matcher: RegExp,
  matches: SearchMatch[]
): Promise<void> {
  if (matches.length > SEARCH_RESULT_CAP) return;
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(absPath);
  } catch {
    return;
  }
  // Cheap binary detection: a NUL byte in the first 8KB is a strong signal
  // we're reading a binary file. ripgrep does the same trick to avoid
  // dumping binary bytes into match output.
  const sniff = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sniff.includes(0)) return;
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  // Drop the trailing empty entry produced by a file that ends in a newline,
  // so we don't report a phantom "line N+1: ''" for files ending with \n.
  const trimmed = text.endsWith("\n") ? lines.slice(0, -1) : lines;
  for (let i = 0; i < trimmed.length; i++) {
    if (matches.length > SEARCH_RESULT_CAP) return;
    const line = trimmed[i];
    // Each scanFile call gets a fresh `lastIndex` because the matcher is not
    // /g-flagged; we just need a boolean test per line.
    if (matcher.test(line)) {
      matches.push({ path: relPath, line: i + 1, text: line });
    }
  }
}

async function loadGitignoreRules(rootDir: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  let content: string;
  try {
    content = await fs.promises.readFile(
      path.join(rootDir, ".gitignore"),
      "utf8"
    );
  } catch {
    return rules;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const rule = parseGitignoreLine(rawLine);
    if (rule) rules.push(rule);
  }
  return rules;
}

function parseGitignoreLine(rawLine: string): IgnoreRule | null {
  // gitignore rules: blank lines and lines starting with `#` are ignored;
  // trailing whitespace is stripped (a literal trailing space must be
  // backslash-escaped, which we don't bother to support); leading `!` flips
  // the rule to a negation, which we deliberately skip because supporting it
  // requires a two-pass evaluation we don't want here.
  let line = rawLine.replace(/\s+$/, "");
  if (line === "" || line.startsWith("#") || line.startsWith("!")) return null;
  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  // A pattern with no slashes (after stripping the trailing one) matches by
  // basename anywhere in the tree; otherwise it's anchored to the gitignore
  // location, which for us is the repo root.
  const basenameOnly = !line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);
  return {
    regex: gitignoreGlobToRegex(line),
    dirOnly,
    basenameOnly,
  };
}

function gitignoreGlobToRegex(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across path separators.
        out += ".*";
        i += 2;
        // Eat a following `/` so `**/foo` doesn't end up requiring a literal
        // `/` after `.*` (which would fail to match top-level `foo`).
        if (glob[i] === "/") i += 1;
      } else {
        // Single `*` matches any run of non-separator characters.
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (/[.+()[\]{}^$|\\]/.test(c)) {
      out += "\\" + c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += "$";
  return new RegExp(out);
}

function isIgnoredPath(
  relPath: string,
  isDir: boolean,
  rules: IgnoreRule[]
): boolean {
  // Always exclude `.git` — git itself never tracks it and ripgrep skips it
  // unconditionally, so doing the same keeps the two backends consistent
  // even when the repo's own `.gitignore` doesn't list it.
  if (relPath === ".git" || relPath.startsWith(".git/")) return true;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.basenameOnly) {
      const base = relPath.split("/").pop() ?? relPath;
      if (rule.regex.test(base)) return true;
    } else {
      if (rule.regex.test(relPath)) return true;
    }
  }
  return false;
}
