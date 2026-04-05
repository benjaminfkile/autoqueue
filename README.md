# gateway-downstream-node-starter

A bare-bones Node.js / Express / TypeScript API template that mirrors the patterns used across the fleet. Clone this, rename the service, and start adding routes.

## What's included

| Layer | Tool |
|-------|------|
| Runtime | Node 20, Express 4 |
| Language | TypeScript (CommonJS target) |
| DB | PostgreSQL via knex |
| Secrets | AWS Secrets Manager |
| Tests | Jest + ts-jest + supertest |
| Containerisation | Docker multi-stage build |

## Project structure

```
index.ts               # Entry point — loads secrets, inits DB, starts server
src/
  app.ts               # Express app factory (routers, middleware)
  interfaces.ts        # IAPISecrets, IDBSecrets, IDBHealth
  types.ts             # TNodeEnvironment
  aws/
    getAppSecrets.ts   # Fetches app config from Secrets Manager
    getDBSecrets.ts    # Fetches DB credentials from Secrets Manager
  db/
    db.ts              # knex singleton — initDb() / getDb()
    health.ts          # getDBConnectionHealth() utility
  routers/
    healthRouter.ts    # GET /api/health  (+ ?verbose=true for DB status)
  middleware/
    protectedRoute.ts  # Optional x-api-key guard for protected routes
__tests__/
  app.test.ts
  healthRouter.test.ts
```

## Getting started

```bash
cp .env.example .env   # fill in your ARNs
npm install
npm run dev            # watch + auto-restart
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Liveness ping (returns service name) |
| GET | `/api/health` | DB connectivity check |
| GET | `/api/health?verbose=true` | DB health with host/proxy details |

## Adding a new route

1. Create `src/routers/myRouter.ts`
2. Register it in `src/app.ts`:
   ```ts
   import myRouter from "./routers/myRouter";
   app.use("/api/my-resource", myRouter);
   ```
3. Add a test in `__tests__/myRouter.test.ts`

## Protecting a route

```ts
import protectedRoute from "./middleware/protectedRoute";
app.use("/api/admin", protectedRoute(), adminRouter);
```

The middleware checks the `x-api-key` header against the `api_key` field in your app secrets. Swap to bcrypt compare if you store a hash.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_REGION` | Yes | AWS region for Secrets Manager |
| `AWS_SECRET_ARN` | Yes | ARN of the app secrets |
| `AWS_DB_SECRET_ARN` | Yes | ARN of the DB credentials |

All other configuration (port, db name, etc.) lives inside those two secrets.

## Docker

```bash
docker build \
  --build-arg AWS_REGION=us-east-1 \
  --build-arg AWS_SECRET_ARN=<arn> \
  --build-arg AWS_DB_SECRET_ARN=<arn> \
  --build-arg NODE_ENVIRONMENT=production \
  -t my-api:latest .

docker run -d --name my-api --network app-net -p 8000:8000 my-api:latest
```

## Tests

```bash
npm test
```
# gateway-downstream-node-starter
# autoqueue
