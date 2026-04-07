import { spawn } from "child_process";
import * as path from "path";

const TIMEOUT_MS = 1_800_000;

export function runClaudeOnIssue(options: {
  reposPath: string;
  owner: string;
  repoName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  anthropicApiKey: string;
}): Promise<{ success: boolean; output: string }> {
  const { reposPath, owner, repoName, issueNumber, issueTitle, issueBody, anthropicApiKey } =
    options;

  const localPath = path.join(reposPath, owner, repoName);

  const prompt = `You are working on GitHub issue #${issueNumber}: ${issueTitle}

Issue description:
${issueBody}

Complete this task fully. Make all necessary code changes in this repository. When you are done, ensure all changes are saved to disk. Do not commit anything.`;

  return new Promise((resolve) => {
    let output = "";
    let settled = false;

    const settle = (result: { success: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn("claude", ["--print", "--dangerously-skip-permissions", prompt], {
      cwd: localPath,
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicApiKey },
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
