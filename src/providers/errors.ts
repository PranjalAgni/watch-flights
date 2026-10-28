export class ProviderSchemaError extends Error {
  constructor(provider: string, detail: string) {
    super(`unexpected response from ${provider} (${detail})`);
    this.name = "ProviderSchemaError";
  }
}
