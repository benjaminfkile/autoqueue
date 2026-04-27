import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import * as secrets from "../secrets";
import { getDefaultModel } from "../db/settings";
import { evaluateCapStatus } from "../services/scheduler";
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
  const { messages, repo_id, model } = req.body as {
    messages?: unknown;
    repo_id?: number | null;
    model?: unknown;
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

  // Optional per-session model override. When the client passes `model`, we
  // use it verbatim; otherwise we fall back to the workspace default read
  // from the settings table on every request (so a settings change takes
  // effect immediately for the next chat).
  let modelOverride: string | null = null;
  if (model !== undefined && model !== null) {
    if (typeof model !== "string" || model.trim().length === 0) {
      return res.status(400).json({ error: "Invalid model" });
    }
    modelOverride = model;
  }

  const apiKey = secrets.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  // Weekly cap gate. Block new chat turns when the trailing-7-day token total
  // is at or above settings.weekly_token_cap. We check here — before any SSE
  // headers are flushed — so we can return a real HTTP 429 with a JSON body
  // the SPA can render, instead of opening a stream and immediately closing
  // it with an `event: error` (which the EventSource client would treat as a
  // generic connection failure). The check is a single round-trip via the
  // shared `evaluateCapStatus` helper used by the scheduler (#328) and
  // systemRouter, so all three surfaces evaluate the cap identically.
  //
  // The check is one-shot at request entry: once we drop into the streaming
  // loop below we never re-check. A turn that crosses the threshold mid-
  // stream still completes — same trade-off the scheduler makes for in-flight
  // tasks. The next turn will be gated.
  //
  // Note: the parent task (#325) also calls out a per-session cap. There is
  // no per-session token counter wired into this router yet, so there's
  // nothing to compare session_token_cap against here. When that counter
  // lands, add the equivalent gate alongside this one (same shape, different
  // numerator).
  try {
    const capStatus = await evaluateCapStatus(getDb());
    if (capStatus.capped) {
      return res.status(429).json({
        error: "weekly_token_cap_reached",
        message:
          `Weekly token cap reached (${capStatus.weekly_total.toLocaleString()} of ${capStatus.weekly_cap?.toLocaleString()} tokens used). ` +
          `The cap is measured over a rolling 7-day window — usage rolls off as activity older than 7 days ages out, ` +
          `so the cap will release gradually as old turns fall outside the window. ` +
          `Raise the cap in Settings to resume immediately, or wait for the window to roll.`,
        weekly_total: capStatus.weekly_total,
        weekly_cap: capStatus.weekly_cap,
      });
    }
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }

  let context;
  let resolvedModel: string;
  try {
    context = await loadChatContext(getDb(), repoIdNum);
    resolvedModel = modelOverride ?? (await getDefaultModel(getDb()));
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
      model: resolvedModel,
      system,
      messages: validated,
      tools: [PROPOSE_TASK_TREE_TOOL, ...REPO_READ_TOOLS],
      repoToolsContext: { db: getDb(), reposPath, scope: context.scope },
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
