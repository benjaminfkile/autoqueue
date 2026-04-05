import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { IAppSecrets } from "../interfaces";

/**
 * Middleware that guards a route with a shared API key.
 * The caller must send the key in the `x-api-key` header.
 * Store a bcrypt hash of the key in app secrets as `API_KEY_HASH`.
 *
 * Usage: app.use("/api/admin", protectedRoute(), adminRouter);
 */
const protectedRoute = () => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets) {
      return res.status(500).json({ error: "Secrets not loaded" });
    }

    const provided = req.headers["x-api-key"];
    if (!provided || typeof provided !== "string") {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const isValid = await bcrypt.compare(provided, secrets.API_KEY_HASH);
    if (!isValid) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    next();
  };
};

export default protectedRoute;
