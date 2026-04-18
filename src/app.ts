import express, { Express, NextFunction, Request, Response } from "express";
// cors and helmet are commented out because this API runs as a downstream service
// behind bk-gateway-api (https://github.com/benjaminfkile/bk-gateway-api), which
// already applies helmet security headers and CORS for all proxied requests.
// If you ever deploy this API directly without the gateway, uncomment these.
//import cors from "cors";
//import helmet from "helmet";
import healthRouter from "./routers/healthRouter";
import issuesRouter from "./routers/issuesRouter";
import reposRouter from "./routers/reposRouter";
import tasksRouter from "./routers/tasksRouter";
import protectedRoute from "./middleware/protectedRoute";

const app: Express = express();

// app.use(helmet());
// app.use(cors());

app.use(express.json());

app.get("/", (req: Request, res: Response) => {
  const secrets = req.app.get("secrets") as { NODE_ENV?: string } | undefined;
  const suffix = secrets?.NODE_ENV === "production" ? "" : "-dev";
  res.send(`grunt-api${suffix}`);
});

app.use("/api/health", healthRouter);
app.use("/api/repos", protectedRoute(), reposRouter);
app.use("/api/issues", protectedRoute(), issuesRouter);
app.use("/api/tasks", protectedRoute(), tasksRouter);

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
