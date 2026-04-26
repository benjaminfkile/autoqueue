import * as fs from "fs";
import { Knex } from "knex";
import { PathTraversalError, resolveRepoPath } from "./repoPath";

// Hard cap on the bytes a single read_file response may return. Sized so the
// model's tool_result stays well below the per-message context budget; large
// files must be sliced via start_line/end_line.
export const READ_FILE_BYTE_CAP = 50 * 1024;

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
