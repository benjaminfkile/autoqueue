import { spawn } from "child_process";
import * as path from "path";
import { TaskPayload } from "../interfaces";

const TIMEOUT_MS = 1_800_000;

export function runClaudeOnTask(options: {
  reposPath: string;
  owner: string;
  repoName: string;
  taskPayload: TaskPayload;
  anthropicApiKey?: string;
  claudePath?: string;
}): Promise<{ success: boolean; output: string }> {
  const { reposPath, owner, repoName, taskPayload, anthropicApiKey, claudePath } =
    options;

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (anthropicApiKey) env.ANTHROPIC_API_KEY = anthropicApiKey;

  const localPath = path.join(reposPath, owner, repoName);

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

  return new Promise((resolve) => {
    let output = "";
    let settled = false;

    const settle = (result: { success: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(resolvedClaudePath, ["--print", "--dangerously-skip-permissions", prompt], {
      cwd: localPath,
      env,
    });

    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
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
