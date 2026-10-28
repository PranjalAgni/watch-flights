import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Handler = (
  url: string,
  init: RequestInit | undefined
) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
}

/**
 * A fetch whose answers come from `handler`; requests honour abort signals like
 * the real one.
 */
export function fakeFetch(handler: Handler): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      headers: { ...(init?.headers as Record<string, string> | undefined) }
    });
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted)
        return reject(new DOMException("aborted", "AbortError"));
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
      Promise.resolve(handler(url, init)).then(resolve, reject);
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** Never answers; only an abort ends it. */
export const hang = (): Promise<Response> => new Promise(() => {});

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

export function readJsonFixture<T = unknown>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}
