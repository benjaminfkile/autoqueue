import { Request } from "express";
import bcrypt from "bcrypt";
import { AuthContext, AuthProvider } from "./AuthProvider";
import { IAppSecrets } from "../interfaces";

/**
 * Authenticates requests by comparing an `x-api-key` header against the
 * bcrypt hash stored in app secrets as `API_KEY_HASH`.
 *
 * Returns null (so the next provider is tried) when:
 *   - app secrets aren't loaded yet,
 *   - the header is missing or non-string,
 *   - bcrypt.compare reports a mismatch.
 */
export class ApiKeyProvider implements AuthProvider {
  readonly name = "api-key";

  async authenticate(req: Request): Promise<AuthContext | null> {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    if (!secrets || !secrets.API_KEY_HASH) return null;

    const provided = req.headers["x-api-key"];
    if (!provided || typeof provided !== "string") return null;

    const ok = await bcrypt.compare(provided, secrets.API_KEY_HASH);
    if (!ok) return null;

    return { provider: this.name, subject: "api-key" };
  }
}

export default ApiKeyProvider;
