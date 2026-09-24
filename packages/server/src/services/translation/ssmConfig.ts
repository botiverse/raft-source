import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";

export type TranslationSsmEnvironment = "staging" | "production";

export type TranslationSsmConfig = {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
};

export type TranslationSsmReader = {
  getParameters(names: readonly string[], withDecryption: boolean): Promise<Record<string, string>>;
};

const SSM_ENVIRONMENT_KEY = "TRANSLATION_SSM_ENVIRONMENT";
const SSM_ROOT = "/slock";
const CACHE_TTL_MS = 5 * 60 * 1000;

export function translationSsmIsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SSM_ENVIRONMENT_KEY]?.trim());
}

export function translationSsmEnvironment(env: NodeJS.ProcessEnv = process.env): TranslationSsmEnvironment {
  const value = (env[SSM_ENVIRONMENT_KEY] ?? "").trim().toLowerCase();
  if (value !== "staging" && value !== "production") {
    throw new Error("TRANSLATION_SSM_ENVIRONMENT must be staging or production");
  }
  return value;
}

export function translationSsmParameterNames(environment: TranslationSsmEnvironment): {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
} {
  const root = `${SSM_ROOT}/${environment}/translation`;
  return {
    provider: `${root}/provider`,
    endpoint: `${root}/endpoint`,
    model: `${root}/model`,
    apiKey: `${root}/api-key`,
  };
}

export function createAwsTranslationSsmReader(env: NodeJS.ProcessEnv = process.env): TranslationSsmReader {
  const client = new SSMClient({ region: env.AWS_REGION?.trim() || undefined });
  return {
    async getParameters(names, withDecryption) {
      const response = await client.send(new GetParametersCommand({
        Names: [...names],
        WithDecryption: withDecryption,
      }));
      const values: Record<string, string> = {};
      for (const parameter of response.Parameters ?? []) {
        if (parameter.Name && parameter.Value !== undefined) values[parameter.Name] = parameter.Value;
      }
      const invalid = response.InvalidParameters ?? [];
      if (invalid.length > 0) throw new Error("translation SSM parameter lookup returned invalid parameters");
      return values;
    },
  };
}

function nonEmptyParameter(values: Record<string, string>, name: string): string {
  const value = values[name]?.trim();
  if (!value) throw new Error("translation SSM configuration is incomplete");
  return value;
}

export async function loadTranslationSsmConfig(
  reader: TranslationSsmReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TranslationSsmConfig> {
  const names = translationSsmParameterNames(translationSsmEnvironment(env));
  const plain = await reader.getParameters([names.provider, names.endpoint, names.model], false);
  const secret = await reader.getParameters([names.apiKey], true);
  return {
    provider: nonEmptyParameter(plain, names.provider).toLowerCase(),
    endpoint: nonEmptyParameter(plain, names.endpoint),
    model: nonEmptyParameter(plain, names.model),
    apiKey: nonEmptyParameter(secret, names.apiKey),
  };
}

export class CachedTranslationSsmConfig {
  private cached?: { config: TranslationSsmConfig; expiresAt: number };
  private inFlight?: Promise<TranslationSsmConfig>;

  constructor(
    private readonly reader: TranslationSsmReader,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly ttlMs = CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(force = false): Promise<TranslationSsmConfig> {
    if (!force && this.cached && this.cached.expiresAt > this.now()) return this.cached.config;
    if (this.inFlight) return this.inFlight;
    this.inFlight = loadTranslationSsmConfig(this.reader, this.env)
      .then((config) => {
        this.cached = { config, expiresAt: this.now() + this.ttlMs };
        return config;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
