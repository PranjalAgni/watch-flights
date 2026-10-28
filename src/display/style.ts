import stringWidth from "string-width";

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  good(text: string): string;
  warn(text: string): string;
  bad(text: string): string;
}

const wrap = (open: number, close: number) => (text: string) =>
  `\x1b[${open}m${text}\x1b[${close}m`;

export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    const plain = (text: string) => text;
    return {
      enabled,
      bold: plain,
      dim: plain,
      accent: plain,
      good: plain,
      warn: plain,
      bad: plain
    };
  }
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    accent: wrap(36, 39),
    good: wrap(32, 39),
    warn: wrap(33, 39),
    bad: wrap(31, 39)
  };
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Terminal display width (wide CJK characters count as two), measured the same
 * way cli-table3 does.
 */
export function visibleLength(text: string): number {
  return stringWidth(text);
}

/**
 * Cuts plain text to at most `max` display columns, ending with "…" when
 * shortened.
 */
export function truncate(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  const budget = max - 1;
  let result = "";
  let used = 0;
  for (const char of text) {
    const w = stringWidth(char);
    if (used + w > budget) break;
    result += char;
    used += w;
  }
  return max <= 0 ? "" : `${result.trimEnd()}…`;
}

/**
 * Colour is used only for terminals that support it, honouring NO_COLOR and
 * FORCE_COLOR.
 */
export function shouldUseColor(
  stream: { isTTY?: boolean },
  env: NodeJS.ProcessEnv
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined)
    return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (!stream.isTTY) return false;
  return env.TERM !== "dumb";
}
