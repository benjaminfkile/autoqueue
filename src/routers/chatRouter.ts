import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import * as secrets from "../secrets";
import {
  buildSystemPrompt,
  ChatMessage,
  loadChatContext,
  PROPOSE_TASK_TREE_TOOL,
  REPO_READ_TOOLS,
  streamChatEvents,
} from "../services/chatService";

const VALID_ROLES: ChatMessage["role"][] = ["user", "assistant"];

const chatRouter = express.Router();

// POST /api/chat — accept a message history (optionally scoped to a repo) and
// stream Claude's reply back as SSE text deltas.
chatRouter.post("/", async (req: Request, res: Response) => {
  const { messages, repo_id } = req.body as {
    messages?: unknown;
    repo_id?: number | null;
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return res
      .status(400)
      .json({ error: "messages must be a non-empty array" });
  }

  const validated: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      return res.status(400).json({ error: "Invalid message entry" });
    }
    const entry = m as { role?: unknown; content?: unknown };
    if (
      typeof entry.role !== "string" ||
      !VALID_ROLES.includes(entry.role as ChatMessage["role"])
    ) {
      return res.status(400).json({ error: "Invalid message role" });
    }
    if (typeof entry.content !== "string" || entry.content.length === 0) {
      return res.status(400).json({ error: "Invalid message content" });
    }
    validated.push({
      role: entry.role as ChatMessage["role"],
      content: entry.content,
    });
  }

  let repoIdNum: number | null = null;
  if (repo_id != null) {
    const parsed =
      typeof repo_id === "number" ? repo_id : parseInt(String(repo_id), 10);
    if (!Number.isFinite(parsed)) {
      return res.status(400).json({ error: "Invalid repo_id" });
    }
    repoIdNum = parsed;
  }

  const apiKey = secrets.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  let context;
  try {
    context = await loadChatContext(getDb(), repoIdNum);
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }

  const system = buildSystemPrompt(context);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  const reposPath = process.env.REPOS_PATH ?? "";

  try {
    for await (const event of streamChatEvents({
      apiKey,
      system,
      messages: validated,
      tools: [PROPOSE_TASK_TREE_TOOL, ...REPO_READ_TOOLS],
      repoToolsContext: { db: getDb(), reposPath },
    })) {
      if (aborted) break;
      if (event.type === "text") {
        res.write(`event: delta\n`);
        res.write(`data: ${JSON.stringify({ text: event.text })}\n\n`);
      } else if (event.type === "proposal") {
        res.write(`event: proposal\n`);
        res.write(
          `data: ${JSON.stringify({ proposal: event.proposal })}\n\n`
        );
      } else if (event.type === "proposal_error") {
        res.write(`event: proposal_error\n`);
        res.write(
          `data: ${JSON.stringify({ error: event.error })}\n\n`
        );
      }
    }
    if (!aborted) {
      res.write(`event: done\n`);
      res.write(`data: {}\n\n`);
    }
  } catch (err) {
    res.write(`event: error\n`);
    res.write(
      `data: ${JSON.stringify({ error: (err as Error).message })}\n\n`
    );
  } finally {
    res.end();
  }
  return;
});

export default chatRouter;
