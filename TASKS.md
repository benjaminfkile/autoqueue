# Copilot Queue — GitHub Issues

---

## ✅ Issue 1 — Create repos and issues database migrations

Create two Knex migration files in `src/db/migrations/` following the existing migration file naming and structure conventions in this project.

**Migration 1 — `repos` table:**
- `id` — serial primary key
- `owner` — varchar, not null (GitHub org or username)
- `repo_name` — varchar, not null
- `active` — boolean, not null, default true
- `webhook_id` — integer, nullable (stores the GitHub webhook ID so it can be deregistered)
- `created_at` — timestamp, not null, default now()
- Add a unique constraint on `(owner, repo_name)`

**Migration 2 — `issues` table:**
- `id` — serial primary key
- `repo_id` — integer, not null, FK → repos.id, on delete cascade
- `issue_number` — integer, not null
- `parent_issue_number` — integer, nullable
- `queue_position` — integer, not null
- `status` — varchar, not null, default 'pending' (values: pending, active, done)
- `is_manual` — boolean, not null, default false
- `created_at` — timestamp, not null, default now()
- Add a unique constraint on `(repo_id, issue_number)`

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 2 — Create repos and issues DB helper modules

Create two typed DB helper modules following the pattern of existing files in `src/db/`.

**`src/db/repos.ts`** — export the following functions, all accepting a `Knex` instance as first arg:
- `getActiveRepos(db)` → `Promise<Repo[]>`
- `getAllRepos(db)` → `Promise<Repo[]>`
- `getRepoById(db, id)` → `Promise<Repo | undefined>`
- `getRepoByOwnerAndName(db, owner, repoName)` → `Promise<Repo | undefined>`
- `createRepo(db, data: { owner, repo_name, active?, webhook_id? })` → `Promise<Repo>`
- `updateRepo(db, id, data: Partial<Repo>)` → `Promise<Repo>`
- `deleteRepo(db, id)` → `Promise<void>`

**`src/db/issues.ts`** — export the following functions:
- `getIssuesByRepoId(db, repoId)` → `Promise<Issue[]>`
- `getIssueByNumber(db, repoId, issueNumber)` → `Promise<Issue | undefined>`
- `getNextPendingIssue(db, repoId)` → `Promise<Issue | undefined>` — returns the lowest queue_position issue with status 'pending' where parent_issue_number is null OR the parent's status is 'done'
- `upsertIssue(db, data: { repo_id, issue_number, parent_issue_number?, queue_position, is_manual? })` → `Promise<Issue>`
- `updateIssueStatus(db, id, status: 'pending' | 'active' | 'done')` → `Promise<Issue>`
- `updateIssue(db, id, data: Partial<Issue>)` → `Promise<Issue>`
- `deleteIssue(db, id)` → `Promise<void>`

Add `Repo` and `Issue` interfaces to `src/interfaces.ts` matching the columns defined in the migrations from the previous task.

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 3 — Create GitHub service module

Create `src/services/github.ts`. This module wraps @octokit/rest and exposes all GitHub API interactions the app needs.

All functions should accept the PAT as their first argument (string) so they stay stateless and testable. Use `new Octokit({ auth: pat })` internally.

Export the following functions:

- `assignCopilot(pat, owner, repo, issueNumber)` — assign @copilot to an issue using the GitHub CLI approach: POST to /repos/{owner}/{repo}/issues/{issue_number}/assignees with assignees: ['app/github-copilot-for-issues']
- `assignHuman(pat, owner, repo, issueNumber, username)` — assign a specific GitHub username to an issue
- `postIssueComment(pat, owner, repo, issueNumber, body)` — post a comment on an issue
- `promoteDraftToReady(pat, owner, repo, prNumber)` — convert a draft PR to ready for review via the GitHub GraphQL API using the `markPullRequestReadyForReview` mutation. First fetch the PR's node_id via REST, then call the mutation.
- `approvePR(pat, owner, repo, prNumber)` — submit an approving review via POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews with event: 'APPROVE'
- `mergePR(pat, owner, repo, prNumber)` — merge a PR with squash method and delete the branch
- `registerWebhook(pat, owner, repo, webhookUrl, secret)` — register a webhook on the repo for events: ['pull_request', 'issues']. Return the webhook id.
- `deregisterWebhook(pat, owner, repo, webhookId)` — delete a webhook by id
- `getOpenIssues(pat, owner, repo)` — fetch all open issues for a repo (handle pagination)

Add `GH_PAT` and `WEBHOOK_SECRET` to the `IAppSecrets` interface in `src/interfaces.ts`.

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 4 — Create queue advancement service

Create `src/services/queue.ts`. This is the core business logic that decides what to do next after an issue is completed.

**`advanceQueue(db: Knex, secrets: IAppSecrets, repoId: number): Promise<void>`**
- Call `getNextPendingIssue(db, repoId)` from the issues DB helper
- If no issue is returned, log "Queue complete for repo {repoId}" and return
- If the issue has `is_manual: true`:
  - Update status to 'active'
  - Assign to the repo owner (get owner via `getRepoById`) using `assignHuman`
  - Post a comment: "👋 Manual task — this requires human action and cannot be completed by the coding agent. Complete the steps above, then close this issue to advance the queue."
- If `is_manual: false`:
  - Update status to 'active'
  - Call `assignCopilot`

**`syncWebhooks(db: Knex, secrets: IAppSecrets, baseUrl: string): Promise<void>`**
- Call `getActiveRepos(db)`
- For each repo that has no `webhook_id`, call `registerWebhook` and save the returned id via `updateRepo`
- Log results

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 5 — Create webhook router to handle GitHub events

Create `src/routers/webhookRouter.ts`.

This router handles all inbound GitHub webhook POST requests at `/api/webhook`.

**Signature verification:**
- Read the raw body using `express.raw({ type: 'application/json' })` on this route only (do not use express.json() here — signature verification requires the raw buffer)
- Verify the GitHub webhook signature from the `x-hub-signature-256` header using HMAC-SHA256 and the `WEBHOOK_SECRET` from app secrets
- Reject with 401 if signature is invalid or header is missing

**Handle the following events based on the `x-github-event` header:**

**1. `pull_request` — action `review_requested`:**
- Check if the PR author login contains 'copilot' (case-insensitive) — if not, ignore and return 200
- This fires when Copilot has finished its work and requests review on the draft PR
- Call `promoteDraftToReady` first, then `approvePR`, then `mergePR` in sequence
- Log the PR number and repo

**2. `pull_request` — action `closed` with `merged: true`:**
- Check if the PR author login contains 'copilot' (case-insensitive) — if not, ignore and return 200
- Look up the repo in the DB by owner + repo name — if not found, return 200
- Find the active issue for that repo (`status = 'active'`) and mark it 'done'
- Call `advanceQueue`

**3. `issues` — action `opened`:**
- Look up the repo in the DB by owner + repo name — if not found or `active = false`, return 200
- Check if the issue has a label named 'manual' and set is_manual accordingly
- Check for a parent issue by inspecting the issue body for a parent reference or sub-issue markers — store parent_issue_number if found, otherwise null
- Determine queue_position as (current max queue_position for that repo + 1), defaulting to 1 if no issues exist yet
- Upsert the issue with status 'pending'
- Call `getNextPendingIssue` — if the newly inserted issue is the next one (i.e. it comes back as the result), call `advanceQueue`

**4. `issues` — action `closed`:**
- Look up the issue in the DB by repo + issue number — if not found, return 200
- If the issue has `is_manual: true` and `status = 'active'`, mark it 'done' and call `advanceQueue`
- This handles the case where a human manually closes their task to advance the queue

All unhandled event/action combos should return 200 immediately.

Register this router in `src/app.ts` at `/api/webhook` BEFORE `express.json()` middleware so the raw body is preserved for signature verification.

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 6 — Create repos REST router

Create `src/routers/reposRouter.ts`. All routes protected by the existing `protectedRoute()` middleware.

**GET /api/repos**
- Return all repos from the DB

**POST /api/repos**
- Body: `{ owner: string, repo_name: string, active?: boolean }`
- Check for duplicate (owner + repo_name) — return 409 if exists
- Create the repo record
- If active is true (default), call `registerWebhook` using BASE_URL from app secrets and save the webhook_id via updateRepo
- Return the created repo

**PATCH /api/repos/:id**
- Body: `Partial<{ active: boolean, owner: string, repo_name: string }>`
- Update the repo
- If `active` is being set to false and the repo has a webhook_id, call `deregisterWebhook` and set webhook_id to null
- If `active` is being set to true and repo has no webhook_id, call `registerWebhook` and save the id
- Return the updated repo

**DELETE /api/repos/:id**
- If repo has a webhook_id, call `deregisterWebhook`
- Delete the repo (cascade will remove its issues)
- Return 204

Register in `src/app.ts`: `app.use('/api/repos', protectedRoute(), reposRouter)`

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 7 — Create issues REST router

Create `src/routers/issuesRouter.ts`. All routes protected by `protectedRoute()`.

**GET /api/issues?repo_id=**
- Required query param: repo_id
- Return all issues for that repo ordered by queue_position asc

**POST /api/issues**
- Body: `{ repo_id, issue_number, parent_issue_number?, queue_position?, is_manual? }`
- If queue_position not provided, default to (max existing queue_position for that repo + 1), or 1 if none exist
- Upsert the issue with status 'pending'
- Return the issue

**PATCH /api/issues/:id**
- Body: `Partial<{ queue_position, status, is_manual, parent_issue_number }>`
- Update and return the issue

**DELETE /api/issues/:id**
- Delete the issue, return 204

Register in `src/app.ts`: `app.use('/api/issues', protectedRoute(), issuesRouter)`

Run `npm run build` after to confirm zero TypeScript errors.

---

## ✅ Issue 8 — Wire up routers, startup webhook sync, and add BASE_URL to secrets

This is the final integration task. No new modules — just wiring everything together.

1. In `src/interfaces.ts`, add `BASE_URL: string` to `IAppSecrets`. This is the public URL of this service (e.g. https://api.yourdomain.com) used when registering GitHub webhooks.

2. In `src/app.ts`:
   - Register `/api/webhook` with its own `express.raw({ type: 'application/json' })` BEFORE the global `express.json()` call so the raw body is preserved for signature verification
   - Import and register: `app.use('/api/webhook', webhookRouter)`
   - Import and register: `app.use('/api/repos', protectedRoute(), reposRouter)`
   - Import and register: `app.use('/api/issues', protectedRoute(), issuesRouter)`

3. In `server.ts`, after `initDb(...)` succeeds, call `syncWebhooks(db, appSecrets, appSecrets.BASE_URL)`. Import `syncWebhooks` from `src/services/queue.ts` and `getDb` from `src/db/db.ts`.

4. Add `BASE_URL` to the AWS secret JSON for this service in Secrets Manager.

5. Run `npm run build` and confirm zero TypeScript errors.

No tests required. No changes to existing routers or middleware.