import express, { Express, NextFunction, Request, Response } from "express";
import path from "path";
import fs from "fs";
// cors and helmet are commented out because this API runs as a downstream service
// behind bk-gateway-api (https://github.com/benjaminfkile/bk-gateway-api), which
// already applies helmet security headers and CORS for all proxied requests.
// If you ever deploy this API directly without the gateway, uncomment these.
//import cors from "cors";
//import helmet from "helmet";
import healthRouter from "./routers/healthRouter";
import authRouter from "./routers/authRouter";
import reposRouter from "./routers/reposRouter";
import tasksRouter from "./routers/tasksRouter";
import systemRouter from "./routers/systemRouter";
import chatRouter from "./routers/chatRouter";
import templatesRouter from "./routers/templatesRouter";
import protectedRoute from "./middleware/protectedRoute";

const app: Express = express();

// app.use(helmet());
// app.use(cors());

app.use(express.json());

// The auth provider chain is resolved at request time from
// app.get("authProviders"), which is populated at startup based on the
// AUTH_PROVIDER config. See src/auth/buildAuthProviders.ts.
app.use("/api/health", healthRouter);
// Auth router exposes /config (which auth flow to drive) and /login (in-app
// USER_PASSWORD_AUTH flow). Both must be reachable before the user has a
// token, so they sit outside protectedRoute.
app.use("/api/auth", authRouter);
app.use("/api/repos", protectedRoute(), reposRouter);
app.use("/api/tasks", protectedRoute(), tasksRouter);
app.use("/api/system", protectedRoute(), systemRouter);
app.use("/api/chat", protectedRoute(), chatRouter);
app.use("/api/templates", protectedRoute(), templatesRouter);

// Static SPA serving for the React + MUI GUI built under /web/dist.
// Resolves both when running compiled (<repo>/dist/src/app.js) and when
// running TypeScript directly (<repo>/src/app.ts via ts-jest/ts-node).
const WEB_DIST = (() => {
  const candidates = [
    path.resolve(__dirname, "..", "..", "web", "dist"),
    path.resolve(__dirname, "..", "web", "dist"),
    path.resolve(process.cwd(), "web", "dist"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
})();
const WEB_INDEX = path.join(WEB_DIST, "index.html");

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false }));
}

// SPA fallback: any non-/api GET that wasn't matched above and accepts HTML
// gets index.html. If the build hasn't been produced yet, fall back to the
// legacy service banner so the API stays usable on its own.
app.get(/^\/(?!api(\/|$)).*/, (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET") return next();
  if (fs.existsSync(WEB_INDEX)) {
    return res.sendFile(WEB_INDEX);
  }
  if (req.path === "/") {
    const secrets = req.app.get("secrets") as { NODE_ENV?: string } | undefined;
    const suffix = secrets?.NODE_ENV === "production" ? "" : "-dev";
    return res.send(`grunt-api${suffix}`);
  }
  return res.status(404).send("Not Found");
});

// TODO: Register additional routers here
// app.use("/api/example", exampleRouter);

app.use(function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (res.headersSent) {
    return next(err);
  }
  console.error("[ErrorHandler]", err);
  res.status(500).json({ status: "error", error: true, errorMsg: err.message });
});

export default app;
