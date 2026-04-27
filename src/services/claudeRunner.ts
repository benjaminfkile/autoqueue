import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  NoteVisibility,
  ParsedAgentNote,
  TaskPayload,
  TokenUsage,
} from "../interfaces";
import { RUNNER_IMAGE_NAME } from "./imageBuilder";
import { MountSpec } from "./mountManifest";

const TIMEOUT_MS = 1_800_000;
const CONTAINER_WORKSPACE = "/workspace";

const VALID_VISIBILITIES: ReadonlySet<NoteVisibility> = new Set([
  "self",
  "siblings",
  "descendants",
  "ancestors",
  "all",
]);

// Match every <NOTES_TO_SAVE>...</NOTES_TO_SAVE> block in the output. The
// agent may emit zero, one, or more blocks across the run; we collect them all.
const NOTES_BLOCK_RE = /<NOTES_TO_SAVE>([\s\S]*?)<\/NOTES_TO_SAVE>/g;

// Render the "Working environment" section of the system prompt. The agent
// runs inside a container with a deliberately small mount surface — the
// primary repo at /workspace :rw plus zero-or-more linked repos under
// /context/<name>. Modes come straight from the mount manifest (which derives
// them from repo_links.permission). The agent must know exactly which paths
// are writable: a write to a :ro mount fails at the kernel layer (EROFS) and
// the agent cannot recover by retrying. Repos absent from this list are not
// mounted at all, so the agent must not assume they exist on disk.
function buildContextLayoutDoc(contextMounts: MountSpec[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("## Working environment");
  lines.push("");
  lines.push(
    "You are running inside a container whose host-visible paths are limited to the mounts listed below. Anything not listed is invisible — do not assume other repos or directories exist on disk."
  );
  lines.push("");
  lines.push(
    "- `/workspace` (read-write) — the primary repo for this task. This is your working directory; make all required code changes here unless the task explicitly says otherwise."
  );

  if (contextMounts.length === 0) {
    lines.push("");
    lines.push("No additional context repos are mounted for this task.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Linked repos mounted under `/context/`:");
  for (const m of contextMounts) {
    const label = m.mode === "rw" ? "read-write" : "read-only";
    lines.push(`- \`${m.containerPath}\` (${label})`);
  }
  lines.push("");
  lines.push(
    "**Read-only paths (`:ro`) must not be modified.** Any write to a read-only mount will fail at the filesystem layer (EROFS / read-only filesystem). Do not retry, chmod, or try to work around the failure — treat read-only repos as reference material only."
  );
  lines.push("");
  lines.push(
    "Read-write context paths (`:rw`) may be edited, but only when the task explicitly requires cross-repo changes. When coordinating across repos:"
  );
  lines.push(
    "- Make the minimum set of changes needed in each repo; keep edits in `/workspace` and any `/context/*` :rw mount consistent with each other."
  );
  lines.push(
    "- Do not run `git commit`, `git push`, or any branch operation inside a `/context/*` mount — commits and merges for linked repos are handled by the task runner outside the container."
  );
  lines.push(
    "- If the task does not call for changes in a writable context repo, treat it as read-only in practice and leave it untouched."
  );

  return lines.join("\n");
}

// Documentation appended to the agent prompt. Describes the structured output
// the agent can emit to leave notes for sibling/ancestor/descendant tasks.
const NOTES_PROTOCOL_DOC = `
## Leaving notes for other tasks (NOTES_TO_SAVE protocol)

If you want to leave notes for future agents working on related tasks (or for
users reviewing this task), emit one or more \`<NOTES_TO_SAVE>\` blocks in your
final output. Each block contains a JSON array of note objects:

<NOTES_TO_SAVE>
[
  {
    "visibility": "siblings",
    "tags": ["context"],
    "content": "Ran lint already; the legacy adapter can be skipped."
  }
]
</NOTES_TO_SAVE>

Each note object has the following fields:
- \`content\` (string, required): the note body. Be concise and concrete.
- \`visibility\` (string, required): one of \`self\`, \`siblings\`, \`descendants\`,
  \`ancestors\`, or \`all\`. Visibility is resolved against the task tree:
  - \`self\`        — only this task sees the note (useful as a private journal).
  - \`siblings\`    — sibling tasks (sharing this task's parent) see the note.
  - \`descendants\` — tasks below this one in the tree see the note.
  - \`ancestors\`   — tasks above this one in the tree see the note.
  - \`all\`         — every task in the same repo sees the note.
- \`tags\` (string array, optional): freeform tags for grouping/filtering.

Notes are persisted only if the task completes successfully. The author is
recorded as \`agent\`. Use this protocol sparingly — only emit notes when the
information is non-obvious and useful to whoever picks up adjacent work.`;

// Parse Anthropic-shaped token usage out of the agent's raw output. The claude
// CLI, when invoked with `--output-format stream-json` or `--output-format json`,
// emits one or more JSON objects whose `usage` (or `message.usage`) field
// mirrors the Anthropic SDK's usage shape. We scan the output for any line
// that parses as a JSON object with a usage block and sum across all such
// blocks so a multi-turn run aggregates correctly.
//
// Returns null when the output contained no recognisable usage info — callers
// use that to decide whether to write a task_usage row at all (avoids storing
// all-zero rows for plain-text logs that predate the JSON output format).
export function parseUsageFromOutput(output: string): TokenUsage | null {
  if (!output) return null;

  const total: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let foundAny = false;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line[0] !== "{") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = extractUsageFromEvent(parsed);
    if (!usage) continue;

    foundAny = true;
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    total.cache_read_input_tokens += usage.cache_read_input_tokens;
  }

  return foundAny ? total : null;
}

function extractUsageFromEvent(obj: unknown): TokenUsage | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  // The Anthropic SDK's usage block sits in one of three places depending on
  // the CLI's output format:
  //   1. top-level `usage`           — `--output-format json` final envelope
  //   2. `message.usage`             — assistant events in stream-json mode
  //   3. `result.usage` (rare)       — some result envelope variants
  let usageRaw: unknown = o.usage;
  if (!usageRaw && o.message && typeof o.message === "object") {
    usageRaw = (o.message as Record<string, unknown>).usage;
  }
  if (!usageRaw && o.result && typeof o.result === "object") {
    usageRaw = (o.result as Record<string, unknown>).usage;
  }
  if (!usageRaw || typeof usageRaw !== "object") return null;

  const u = usageRaw as Record<string, unknown>;
  const input = numberField(u.input_tokens);
  const output = numberField(u.output_tokens);
  const cacheCreate = numberField(u.cache_creation_input_tokens);
  const cacheRead = numberField(u.cache_read_input_tokens);

  if (input === 0 && output === 0 && cacheCreate === 0 && cacheRead === 0) {
    return null;
  }

  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
  };
}

function numberField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function parseNotesFromOutput(output: string): ParsedAgentNote[] {
  const notes: ParsedAgentNote[] = [];
  for (const match of output.matchAll(NOTES_BLOCK_RE)) {
    const body = match[1].trim();
    if (!body) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      console.error(
        "[claudeRunner] Failed to parse NOTES_TO_SAVE block as JSON:",
        (err as Error).message
      );
      continue;
    }

    if (!Array.isArray(parsed)) {
      console.error(
        "[claudeRunner] NOTES_TO_SAVE block must contain a JSON array"
      );
      continue;
    }

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const content = e.content;
      const visibility = e.visibility;
      const tags = e.tags;

      if (typeof content !== "string" || content.trim() === "") {
        console.error(
          "[claudeRunner] Skipping note with missing/empty 'content'"
        );
        continue;
      }
      if (
        typeof visibility !== "string" ||
        !VALID_VISIBILITIES.has(visibility as NoteVisibility)
      ) {
        console.error(
          `[claudeRunner] Skipping note with invalid 'visibility': ${String(
            visibility
          )}`
        );
        continue;
      }

      let tagList: string[] | undefined;
      if (tags !== undefined) {
        if (
          !Array.isArray(tags) ||
          tags.some((t) => typeof t !== "string")
        ) {
          console.error(
            "[claudeRunner] Skipping note with invalid 'tags' (must be string[])"
          );
          continue;
        }
        tagList = tags as string[];
      }

      const note: ParsedAgentNote = {
        visibility: visibility as NoteVisibility,
        content,
      };
      if (tagList !== undefined) note.tags = tagList;
      notes.push(note);
    }
  }
  return notes;
}

export function runClaudeOnTask(options: {
  workDir: string;
  taskPayload: TaskPayload;
  anthropicApiKey?: string;
  ghPat?: string;
  logFilePath?: string;
  onFirstByte?: () => void;
  // Phase 10: bind-mount each linked repo at /context/<name>. Built by
  // buildMountManifest from repo_links — :ro for read-only links, :rw for
  // write-allowed ones. Anything not in this list is invisible to the container.
  contextMounts?: MountSpec[];
  // Phase 11: the effective Claude model for this task (resolved by
  // taskRunner via resolveTaskModel). Forwarded to the CLI as `--model <id>`
  // so each run targets the user-selected model rather than the CLI default.
  model?: string;
}): Promise<{
  success: boolean;
  output: string;
  notes: ParsedAgentNote[];
  usage: TokenUsage | null;
}> {
  const {
    workDir,
    taskPayload,
    anthropicApiKey,
    ghPat,
    logFilePath,
    onFirstByte,
    contextMounts,
    model,
  } = options;

  const env: NodeJS.ProcessEnv = { ...process.env };

  // Secrets are delivered to the container via a tmpfs-backed file rather
  // than `docker -e KEY=value`, because `docker inspect` exposes -e values
  // verbatim. The host writes KEY=value lines to docker stdin; the
  // container entrypoint reads them into a file at /run/grunt-secrets/env
  // (a RAM-only tmpfs), sources them into the env, and unlinks the file
  // before exec'ing the claude CLI.
  const secretLines: string[] = [];
  if (anthropicApiKey) secretLines.push(`ANTHROPIC_API_KEY=${anthropicApiKey}`);
  if (ghPat) secretLines.push(`GH_PAT=${ghPat}`);
  const hasSecrets = secretLines.length > 0;

  const contextLayoutDoc = buildContextLayoutDoc(contextMounts ?? []);

  const prompt = `You are an automated coding agent. You have been assigned the following task:

${JSON.stringify(taskPayload, null, 2)}
${contextLayoutDoc}

Instructions:
- Complete the task described above.
- Your work is considered complete when all acceptance criteria are met.
- Make all necessary code changes in this repository.
- When you are done, ensure all changes are saved to disk.
- Do not commit anything.
- The \`task.notes\` array contains notes left by previous agents and by users that are visible to this task per the project's note-visibility rules. Read it carefully before starting — it may contain context, warnings, or follow-up guidance that affects how you should approach this task. An empty array means no notes are visible to this task.
${NOTES_PROTOCOL_DOC}`;

  let logStream: fs.WriteStream | null = null;
  if (logFilePath) {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  }

  let firstByteSeen = false;
  const handleFirstByte = () => {
    if (firstByteSeen) return;
    firstByteSeen = true;
    if (onFirstByte) {
      try {
        onFirstByte();
      } catch (err) {
        console.error("[claudeRunner] onFirstByte callback failed:", err);
      }
    }
  };

  return new Promise((resolve) => {
    let output = "";
    let settled = false;

    const settle = (result: {
      success: boolean;
      output: string;
      notes: ParsedAgentNote[];
      usage: TokenUsage | null;
    }) => {
      if (settled) return;
      settled = true;
      if (logStream) {
        const stream = logStream;
        stream.end(() => resolve(result));
      } else {
        resolve(result);
      }
    };

    // The runner image was built/tagged by ensureRunnerImage before this task
    // started, so `:latest` reliably points at the current build. The repo is
    // bind-mounted at /workspace :rw and that's the container's cwd.
    //
    // Secrets path: when there are secrets to inject we mount a 1MB tmpfs at
    // /run/grunt-secrets (mode 01777 so the unprivileged `node` user can write
    // there), set GRUNT_SECRETS_FROM_STDIN=1, and feed KEY=value lines to
    // docker's stdin with `-i`. The container entrypoint reads stdin into a
    // file on that tmpfs, exports the values, and unlinks the file before
    // exec'ing claude. Compared to `-e KEY=value`, the secret values never
    // appear in `docker inspect` and never reach disk.
    //
    // `--output-format stream-json` makes the CLI emit one JSON object per
    // event (including a `usage` block on assistant messages and the final
    // result envelope). `--verbose` is required for stream-json to include the
    // result envelope. Without these, usage is unavailable from the CLI and
    // task_usage rows can never be written.
    const dockerArgs: string[] = [
      "run",
      "--rm",
      "-v",
      `${workDir}:${CONTAINER_WORKSPACE}:rw`,
    ];
    // Phase 10: append one -v per linked-repo mount. Inserted *before* -w and
    // the image positional so docker still parses them as flags. The manifest
    // controls the entire mount surface — anything not here is unreachable
    // from inside the container.
    for (const mount of contextMounts ?? []) {
      dockerArgs.push("-v", `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
    }
    dockerArgs.push("-w", CONTAINER_WORKSPACE);
    if (hasSecrets) {
      dockerArgs.push(
        "--tmpfs",
        "/run/grunt-secrets:rw,size=1m,mode=01777",
        "-i",
        "-e",
        "GRUNT_SECRETS_FROM_STDIN=1"
      );
    }
    dockerArgs.push(
      `${RUNNER_IMAGE_NAME}:latest`,
      "claude",
      "--print",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose"
    );
    // Phase 11: route the run to the resolved model. The flag is omitted when
    // no model was supplied (defensive — taskRunner always supplies one in
    // production, but unit tests and ad-hoc callers may not).
    if (model && model !== "") {
      dockerArgs.push("--model", model);
      console.log(
        `[claudeRunner] Running task #${taskPayload.task.id} with model: ${model}`
      );
    }
    dockerArgs.push(prompt);

    const child = spawn("docker", dockerArgs, {
      env,
      // With no secrets, the CLI would otherwise wait 3s for piped input, so
      // we close stdin. With secrets, we need a writable stdin so the
      // entrypoint can read the KEY=value stream from us.
      stdio: (hasSecrets
        ? ["pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"]) as ("pipe" | "ignore")[],
    });

    if (hasSecrets && child.stdin) {
      // Newline-terminated KEY=value list. Trailing newline is required so the
      // last line is parsed reliably by `read` in the entrypoint.
      child.stdin.write(secretLines.join("\n") + "\n");
      child.stdin.end();
    }

    child.stdout!.on("data", (data: Buffer) => {
      handleFirstByte();
      output += data.toString();
      if (logStream) logStream.write(data);
    });

    child.stderr!.on("data", (data: Buffer) => {
      handleFirstByte();
      output += data.toString();
      if (logStream) logStream.write(data);
    });

    const timer = setTimeout(() => {
      child.kill();
      settle({
        success: false,
        output: "Timed out after 30 minutes",
        notes: [],
        usage: null,
      });
    }, TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const notes = parseNotesFromOutput(output);
      const usage = parseUsageFromOutput(output);
      if (code === 0) {
        settle({ success: true, output, notes, usage });
      } else {
        settle({ success: false, output, notes, usage });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      output += err.message;
      settle({ success: false, output, notes: [], usage: null });
    });
  });
}
