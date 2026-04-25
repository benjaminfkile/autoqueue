import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { NoteVisibility, ParsedAgentNote, TaskPayload } from "../interfaces";

const TIMEOUT_MS = 1_800_000;

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
  claudePath?: string;
  logFilePath?: string;
  onFirstByte?: () => void;
}): Promise<{ success: boolean; output: string; notes: ParsedAgentNote[] }> {
  const {
    workDir,
    taskPayload,
    anthropicApiKey,
    claudePath,
    logFilePath,
    onFirstByte,
  } = options;

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (anthropicApiKey) env.ANTHROPIC_API_KEY = anthropicApiKey;

  const prompt = `You are an automated coding agent. You have been assigned the following task:

${JSON.stringify(taskPayload, null, 2)}

Instructions:
- Complete the task described above.
- Your work is considered complete when all acceptance criteria are met.
- Make all necessary code changes in this repository.
- When you are done, ensure all changes are saved to disk.
- Do not commit anything.
- The \`task.notes\` array contains notes left by previous agents and by users that are visible to this task per the project's note-visibility rules. Read it carefully before starting — it may contain context, warnings, or follow-up guidance that affects how you should approach this task. An empty array means no notes are visible to this task.
${NOTES_PROTOCOL_DOC}`;

  // Prefer explicit arg, then .env/process env, then PATH lookup.
  const resolvedClaudePath = claudePath ?? process.env.CLAUDE_PATH ?? "claude";

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

    const child = spawn(resolvedClaudePath, ["--print", "--dangerously-skip-permissions", prompt], {
      cwd: workDir,
      env,
    });

    child.stdout.on("data", (data: Buffer) => {
      handleFirstByte();
      output += data.toString();
      if (logStream) logStream.write(data);
    });

    child.stderr.on("data", (data: Buffer) => {
      handleFirstByte();
      output += data.toString();
      if (logStream) logStream.write(data);
    });

    const timer = setTimeout(() => {
      child.kill();
      settle({ success: false, output: "Timed out after 30 minutes", notes: [] });
    }, TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const notes = parseNotesFromOutput(output);
      if (code === 0) {
        settle({ success: true, output, notes });
      } else {
        settle({ success: false, output, notes });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      output += err.message;
      settle({ success: false, output, notes: [] });
    });
  });
}
