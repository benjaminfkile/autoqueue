import crypto from "crypto";
import express, { Request, Response } from "express";
import { getDb } from "../db/db";
import {
  getIssueByNumber,
  getIssuesByRepoId,
  getNextPendingIssue,
  updateIssueStatus,
  upsertIssue,
} from "../db/issues";
import { getRepoByOwnerAndName } from "../db/repos";
import { IAppSecrets } from "../interfaces";
import { approvePR, mergePR, promoteDraftToReady } from "../services/github";
import { advanceQueue } from "../services/queue";

const webhookRouter = express.Router();

function verifySignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) return false;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const expected = `sha256=${hmac.digest("hex")}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

function parseParentIssueUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

webhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    const signatureHeader = req.headers["x-hub-signature-256"] as
      | string
      | undefined;
    if (
      !verifySignature(secrets.WEBHOOK_SECRET, req.body as Buffer, signatureHeader)
    ) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = req.headers["x-github-event"] as string | undefined;
    const payload = JSON.parse((req.body as Buffer).toString("utf-8"));
    const action = payload.action as string | undefined;

    const db = getDb();

    // --- pull_request events ---
    if (event === "pull_request") {
      const prAuthor: string = payload.pull_request?.user?.login ?? "";
      const prNumber: number = payload.pull_request?.number;
      const owner: string = payload.repository?.owner?.login;
      const repoName: string = payload.repository?.name;

      if (action === "review_requested") {
        if (!prAuthor.toLowerCase().includes("copilot")) {
          return res.status(200).json({ ok: true });
        }
        console.log(
          `[webhook] PR #${prNumber} review_requested in ${owner}/${repoName}`
        );
        try {
          await promoteDraftToReady(secrets.GH_PAT, owner, repoName, prNumber);
          await approvePR(secrets.GH_PAT, owner, repoName, prNumber);
          await mergePR(secrets.GH_PAT, owner, repoName, prNumber);
        } catch (err) {
          console.error("[webhook] pull_request review_requested error:", err);
        }
        return res.status(200).json({ ok: true });
      }

      if (action === "closed" && payload.pull_request?.merged === true) {
        if (!prAuthor.toLowerCase().includes("copilot")) {
          return res.status(200).json({ ok: true });
        }
        const repo = await getRepoByOwnerAndName(db, owner, repoName);
        if (!repo) {
          return res.status(200).json({ ok: true });
        }
        const issues = await getIssuesByRepoId(db, repo.id);
        const activeIssue = issues.find((i) => i.status === "active");
        if (activeIssue) {
          await updateIssueStatus(db, activeIssue.id, "done");
          await advanceQueue(db, secrets, repo.id);
        }
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    // --- issues events ---
    if (event === "issues") {
      const owner: string = payload.repository?.owner?.login;
      const repoName: string = payload.repository?.name;
      const issueNumber: number = payload.issue?.number;

      if (action === "opened") {
        const repo = await getRepoByOwnerAndName(db, owner, repoName);
        if (!repo || !repo.active) {
          return res.status(200).json({ ok: true });
        }

        const labels: Array<{ name: string }> = payload.issue?.labels ?? [];
        const isManual = labels.some(
          (l) => l.name.toLowerCase() === "manual"
        );

        const parentIssueNumber = parseParentIssueUrl(
          (payload.issue as { parent_issue_url?: string | null })?.parent_issue_url
        );

        const allIssues = await getIssuesByRepoId(db, repo.id);
        const maxPos = allIssues.reduce(
          (max, i) => Math.max(max, i.queue_position),
          0
        );
        const queuePosition = maxPos + 1;

        await upsertIssue(db, {
          repo_id: repo.id,
          issue_number: issueNumber,
          parent_issue_number: parentIssueNumber,
          queue_position: queuePosition,
          is_manual: isManual,
        });

        const nextPending = await getNextPendingIssue(db, repo.id);
        if (nextPending && nextPending.issue_number === issueNumber) {
          await advanceQueue(db, secrets, repo.id);
        }

        return res.status(200).json({ ok: true });
      }

      if (action === "closed") {
        const repo = await getRepoByOwnerAndName(db, owner, repoName);
        if (!repo) {
          return res.status(200).json({ ok: true });
        }
        const issue = await getIssueByNumber(db, repo.id, issueNumber);
        if (!issue) {
          return res.status(200).json({ ok: true });
        }
        if (issue.is_manual && issue.status === "active") {
          await updateIssueStatus(db, issue.id, "done");
          await advanceQueue(db, secrets, repo.id);
        }
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }
);

export default webhookRouter;
