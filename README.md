# autoqueue

> *"Just because you can, doesn't mean you should."*
> — nobody who ever tried to automate their entire GitHub workflow

An AWS-hosted service that manages a sequential GitHub issue queue and uses GitHub Copilot as an autonomous coding agent. Add repos, throw issues at them, and watch Copilot work through the queue one issue at a time — assigning itself, opening PRs, and getting them approved and merged without you lifting a finger.

## How it works

1. You add a GitHub repo to autoqueue via the API
2. The service registers a webhook on that repo
3. Issues are queued in order. Only one is active at a time
4. When an issue becomes active, the service assigns `@Copilot` to it (or the repo owner if the issue is labeled `manual`)
5. Copilot works the issue and opens a PR
6. When review is requested, the service promotes the PR from draft, approves it, and squash-merges it (deleting the branch)
7. On merge, the active issue is marked done and the next one in the queue advances automatically

**Container issues** (parent issues with sub-issues) are skipped automatically — the queue falls through to their children.

**Manual issues** (labeled `manual`) are assigned to the repo owner with a comment explaining human action is needed. Closing the issue manually advances the queue.

## Stack

| Layer | Tool |
|-------|------|
| Runtime | Node 20, Express 4 |
| Language | TypeScript (CommonJS) |
| DB | PostgreSQL via Knex |
| Secrets | AWS Secrets Manager |
| Tests | Jest + ts-jest + supertest |
| Containerisation | Docker multi-stage build |

## Prerequisites

- A GitHub Personal Access Token (PAT) with `repo` and `admin:repo_hook` scopes
- A webhook secret (any random string — used to verify payloads from GitHub)
- PostgreSQL database
- AWS account with two Secrets Manager secrets (see below)
- The service must be publicly reachable so GitHub can deliver webhooks (`BASE_URL`)

## AWS Secrets Manager

This service reads all config from two Secrets Manager secrets. Set the ARNs via environment variables at runtime.

**App secrets** (`AWS_SECRET_ARN`):

```json
{
  "NODE_ENV": "production",
  "PORT": "8000",
  "DB_NAME": "autoqueue",
  "DB_HOST": "your-db-host",
  "DB_PROXY_URL": "your-rds-proxy-url",
  "API_KEY_HASH": "bcrypt-hash-of-your-api-key",
  "GH_PAT": "github_pat_...",
  "WEBHOOK_SECRET": "your-random-webhook-secret",
  "BASE_URL": "https://your-public-service-url"
}
```

**DB secrets** (`AWS_DB_SECRET_ARN`):

```json
{
  "username": "db-user",
  "password": "db-password"
}
```

## Project structure

```
index.ts                        # Entry point — loads secrets, inits DB, starts server
src/
  app.ts                        # Express app factory
  interfaces.ts                 # TypeScript interfaces
  aws/
    getAppSecrets.ts            # Fetches app config from Secrets Manager
    getDBSecrets.ts             # Fetches DB credentials from Secrets Manager
  db/
    db.ts                       # Knex singleton
    issues.ts                   # Issue DB queries
    repos.ts                    # Repo DB queries
    migrations/                 # Knex migrations (repos + issues tables)
  routers/
    healthRouter.ts             # GET /api/health
    reposRouter.ts              # CRUD for managed repos
    issuesRouter.ts             # CRUD for queued issues
    webhookRouter.ts            # Receives and processes GitHub webhook events
  services/
    github.ts                   # GitHub API helpers (assign, approve, merge, etc.)
    queue.ts                    # Queue logic (advanceQueue, syncWebhooks, backfillIssues)
  middleware/
    protectedRoute.ts           # x-api-key guard
```

## Getting started

```bash
npm install
npm run dev     # watch + auto-restart
```

On startup the service will:
- Connect to PostgreSQL and run any pending migrations
- Call `syncWebhooks` to register webhooks on any active repos that don't have one yet

## Endpoints

All routes except `/` and `/api/health` require an `x-api-key` header.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Liveness ping |
| GET | `/api/health` | DB connectivity check |
| GET | `/api/health?verbose=true` | DB health with host/proxy details |
| GET | `/api/repos` | List all managed repos |
| POST | `/api/repos` | Add a repo (registers webhook automatically) |
| PATCH | `/api/repos/:id` | Update a repo |
| DELETE | `/api/repos/:id` | Remove a repo (deregisters webhook) |
| GET | `/api/issues?repo_id=` | List queued issues for a repo |
| POST | `/api/issues` | Manually add an issue to the queue |
| PATCH | `/api/issues/:id` | Update an issue (e.g. reorder, change status) |
| DELETE | `/api/issues/:id` | Remove an issue from the queue |
| POST | `/api/webhook` | GitHub webhook receiver (HMAC-verified) |

## Adding a repo

```bash
curl -X POST https://your-service/api/repos \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{ "owner": "your-github-username", "repo_name": "your-repo" }'
```

This registers the webhook on GitHub automatically. Any open issues on the repo can be backfilled via `POST /api/repos/:id/backfill`.

## Backfilling existing issues

If a repo already has open issues before you add it, call the backfill endpoint:

```bash
curl -X POST https://your-service/api/repos/:id/backfill \
  -H "x-api-key: your-api-key"
```

This pulls all open issues from GitHub (excluding PRs), sorts them by issue number, and inserts any that aren't already in the queue.

## Manual issues

Label any GitHub issue with `manual` and the service will assign it to the repo owner instead of Copilot, and post a comment explaining that a human needs to complete it. Closing the issue advances the queue.

## Docker

```bash
docker build \
  --build-arg AWS_REGION=us-east-1 \
  --build-arg AWS_SECRET_ARN=<arn> \
  --build-arg AWS_DB_SECRET_ARN=<arn> \
  --build-arg NODE_ENVIRONMENT=production \
  -t autoqueue:latest .

docker run -d --name autoqueue --network app-net -p 8000:8000 autoqueue:latest
```

## Tests

```bash
npm test
```
# file-manager-api
# autoqueue
