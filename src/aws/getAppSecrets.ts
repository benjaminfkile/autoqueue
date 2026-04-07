import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { IAppSecrets } from "../interfaces";

export async function getAppSecrets(): Promise<IAppSecrets> {
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION,
  });

  const command = new GetSecretValueCommand({
    SecretId: process.env.AWS_SECRET_ARN,
  });

  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error("SecretString is empty in Secrets Manager response");
  }

  const parsed = JSON.parse(response.SecretString) as IAppSecrets;

  // Allow local env vars to supplement or override secrets (e.g. CLAUDE_PATH)
  return {
    ...parsed,
    ...(process.env.CLAUDE_PATH ? { CLAUDE_PATH: process.env.CLAUDE_PATH } : {}),
  };
}
