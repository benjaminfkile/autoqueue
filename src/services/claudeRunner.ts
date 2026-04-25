import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { TaskPayload } from "../interfaces";

const TIMEOUT_MS = 1_800_000;

export function runClaudeOnTask(options: {
  workDir: string;
  taskPayload: TaskPayload;
  anthropicApiKey?: string;
  claudePath?: string;
  logFilePath?: string;
  onFirstByte?: () => void;
}): Promise<{ success: boolean; output: string }> {
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
- Do not commit anything.`;

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

    const settle = (result: { success: boolean; output: string }) => {
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
      settle({ success: false, output: "Timed out after 30 minutes" });
    }, TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        settle({ success: true, output });
      } else {
        settle({ success: false, output });
      }
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      output += err.message;
      settle({ success: false, output });
    });
  });
}
