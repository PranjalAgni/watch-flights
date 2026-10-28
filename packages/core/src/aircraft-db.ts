export interface AircraftDbRecord {
  registration: string | null;
  typeCode: string | null;
  description: string | null;
  ownerOperator: string | null;
}

export class AircraftDbSchemaError extends Error {
  constructor(detail: string) {
    super(`aircraft database failed validation (${detail})`);
    this.name = "AircraftDbSchemaError";
  }
}

/**
 * tar1090-db rows: `icao;registration;type;dbFlags;description;year;ownOp;`.
 * Rows are kept as raw strings keyed by lowercase hex and parsed on lookup to
 * keep memory low.
 */
export class AircraftDb {
  static readonly empty = new AircraftDb(new Map());

  constructor(private readonly rows: ReadonlyMap<string, string>) {}

  get size(): number {
    return this.rows.size;
  }

  lookup(hex: string): AircraftDbRecord | null {
    const row = this.rows.get(hex.toLowerCase());
    if (row === undefined) return null;
    const [registration, typeCode, , description, , ownOp] = row.split(";");
    return {
      registration: field(registration),
      typeCode: field(typeCode),
      description: field(description),
      ownerOperator: cleanOwnerOperator(ownOp)
    };
  }
}

const HEX_PATTERN = /^[0-9a-fA-F]{6}$/;

export function parseAircraftCsv(text: string, minRows = 1): AircraftDb {
  const rows = new Map<string, string>();
  let malformed = 0;
  let total = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line =
      text.charCodeAt(end - 1) === 13
        ? text.slice(start, end - 1)
        : text.slice(start, end);
    start = end + 1;
    if (line === "") continue;
    total++;
    const separator = line.indexOf(";");
    const hex = line.slice(0, separator);
    const rest = line.slice(separator + 1);
    if (
      separator !== 6 ||
      !HEX_PATTERN.test(hex) ||
      countSemicolons(rest) < 6
    ) {
      malformed++;
      continue;
    }
    rows.set(hex.toLowerCase(), rest);
  }
  if (total === 0) throw new AircraftDbSchemaError("no rows");
  if (malformed / total > 0.01)
    throw new AircraftDbSchemaError(`${malformed} of ${total} rows malformed`);
  if (rows.size < minRows)
    throw new AircraftDbSchemaError(
      `only ${rows.size} rows, expected at least ${minRows}`
    );
  return new AircraftDb(rows);
}

function countSemicolons(value: string): number {
  let count = 0;
  for (let i = value.indexOf(";"); i !== -1; i = value.indexOf(";", i + 1))
    count++;
  return count;
}

function field(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Drops tar1090-db annotations such as "(Miscode - VARIOUS)" and "(Hex also
 * used by ...)".
 */
export function cleanOwnerOperator(value: string | undefined): string | null {
  const cleaned = value
    ?.replace(/\((?:Miscode|Hex also used)[^)]*\)/gi, "")
    .replace(/^\s*Miscode\b.*$/i, "")
    .trim();
  return cleaned ? cleaned : null;
}
