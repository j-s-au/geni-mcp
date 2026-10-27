// Accepts the many ways people refer to Geni objects and returns the
// `<type>-<id>` form the REST API expects.

export type GeniType =
  | "profile"
  | "union"
  | "document"
  | "photo"
  | "photo_album"
  | "video"
  | "project"
  | "surname"
  | "revision";

/** Geni GUIDs ("Geni IDs" on website URLs) are long numbers starting with 6000. */
const GUID_PATTERN = /^6\d{15,}$/;

export class InvalidIdError extends Error {}

export function normalizeId(type: GeniType, input: string): string {
  const raw = input.trim();
  if (!raw) throw new InvalidIdError(`Empty ${type} id`);

  // API URL, e.g. https://www.geni.com/api/profile-123
  const apiMatch = raw.match(/\/api\/([a-z_]+-g?\d+)(?:[/?#]|$)/i);
  if (apiMatch?.[1]) return checkType(type, apiMatch[1].toLowerCase());

  // Website URL, e.g. https://www.geni.com/people/Jan-Example/6999999999999999999
  if (/^https?:\/\//i.test(raw)) {
    const guid = raw.match(/\/(6\d{15,})(?:[/?#]|$)/)?.[1];
    if (guid && type === "profile") return `profile-g${guid}`;
    const node = raw.match(/\/(?:[a-z_]+\/)?([a-z_]+-\d+)(?:[/?#]|$)/i)?.[1];
    if (node) return checkType(type, node.toLowerCase());
    throw new InvalidIdError(`Could not find a ${type} id in URL ${raw}`);
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith(`${type}-`)) return checkType(type, lower);
  if (/^g\d+$/.test(lower)) return `${type}-${lower}`;
  if (GUID_PATTERN.test(lower) && type === "profile") return `profile-g${lower}`;
  if (/^\d+$/.test(lower)) return `${type}-${lower}`;
  if (/^[a-z_]+-g?\d+$/.test(lower)) return checkType(type, lower);
  throw new InvalidIdError(`Unrecognised ${type} id "${raw}"`);
}

function checkType(type: GeniType, id: string): string {
  if (!id.startsWith(`${type}-`)) {
    throw new InvalidIdError(`Expected a ${type} id but got "${id}"`);
  }
  if (!/^[a-z_]+-g?\d+$/.test(id)) throw new InvalidIdError(`Malformed id "${id}"`);
  return id;
}

export const profileId = (input: string) => normalizeId("profile", input);
export const unionId = (input: string) => normalizeId("union", input);

/** Turns an API URL reference (the default in responses) into a bare node id. */
export function refToId(ref: string): string {
  const match = ref.match(/(?:^|\/)([a-z_]+-g?\d+)(?:[/?#]|$)/i);
  return match?.[1] ? match[1].toLowerCase() : ref;
}
