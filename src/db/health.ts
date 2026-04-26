import { Knex } from "knex";
import { IDBHealth } from "../interfaces";

const health = {
  getDBConnectionHealth: async (
    db: Knex,
    verbose: boolean = false
  ): Promise<IDBHealth> => {
    const messages: string[] = [];
    const timestamp = new Date().toISOString();

    try {
      await db.raw("SELECT 1+1 AS result");

      const filename: string | undefined =
        db.client.config.connection?.filename;

      if (verbose) {
        messages.push("Database connection successful");
        messages.push(`File: ${filename}`);
      }

      return {
        connected: true,
        connectionUsesProxy: false,
        ...(verbose && { logs: { messages, host: filename, timestamp } }),
      };
    } catch (err: any) {
      if (verbose) {
        messages.push("Database connection failed");
        messages.push(`Error: ${err.message || String(err)}`);
      }

      return {
        connected: false,
        connectionUsesProxy: false,
        ...(verbose && {
          logs: {
            messages,
            timestamp,
            error: err.message || String(err),
          },
        }),
      };
    }
  },
};

export default health;
