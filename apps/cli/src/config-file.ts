import { readFile } from "node:fs/promises";
import { type AppConfig, ConfigError, parseConfig } from "@watch-flights/core";

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(path, [
      code === "ENOENT"
        ? "file not found"
        : `cannot read file (${code ?? String(error)})`
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(path, [
      `not valid JSON: ${(error as Error).message}`
    ]);
  }
  return parseConfig(raw, path);
}
