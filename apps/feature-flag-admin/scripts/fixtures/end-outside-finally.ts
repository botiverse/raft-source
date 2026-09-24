import { Client } from "pg";

type Env = { connectionString?: string };

function getClient(env: Env): Client | null {
  if (!env.connectionString) return null;
  return new Client({ connectionString: env.connectionString });
}

async function withOperatorClient<T>(
  env: Env,
  operation: (client: Client) => Promise<T>,
): Promise<T | null> {
  const client = getClient(env);
  if (!client) return null;
  try {
    await client.connect();
    const result = await operation(client);
    await client.end();
    return result;
  } finally {
    // Deliberately empty: the verifier must require end() in this block.
  }
}

void withOperatorClient;
