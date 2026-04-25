import { Request, Response, NextFunction } from "express";
import { AuthContext, AuthProvider } from "../auth/AuthProvider";
import { ApiKeyProvider } from "../auth/ApiKeyProvider";
import { IAppSecrets } from "../interfaces";

/**
 * Middleware that guards a route by trying each registered AuthProvider in
 * order. The first provider to return a non-null AuthContext authenticates
 * the request; the context is attached to req.auth for downstream handlers.
 * If every provider returns null, the response is 401.
 *
 * Defaults to a single ApiKeyProvider so existing call sites that don't pass
 * an explicit list keep their previous behavior.
 *
 * Usage:
 *   app.use("/api/admin", protectedRoute([new ApiKeyProvider()]), adminRouter);
 */
const protectedRoute = (
  providers: AuthProvider[] = [new ApiKeyProvider()]
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    for (const provider of providers) {
      const ctx = await provider.authenticate(req);
      if (ctx) {
        (req as Request & { auth?: AuthContext }).auth = ctx;
        return next();
      }
    }

    return res.status(401).json({ error: "Unauthorized" });
  };
};

export default protectedRoute;
