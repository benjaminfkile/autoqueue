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
 * Provider chain resolution (highest precedence first):
 *   1. The explicit `providers` argument (used by tests / specialized routes).
 *   2. `req.app.get("authProviders")` — populated at startup from
 *      `buildAuthProviders(secrets)` based on the AUTH_PROVIDER config.
 *   3. A single ApiKeyProvider fallback so legacy call sites and minimal
 *      tests that only set API_KEY_HASH continue to work.
 *
 * Usage:
 *   app.use("/api/admin", protectedRoute(), adminRouter);
 */
const protectedRoute = (providers?: AuthProvider[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    const chain =
      providers ??
      (req.app.get("authProviders") as AuthProvider[] | undefined) ??
      [new ApiKeyProvider()];

    for (const provider of chain) {
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
