// Compact, readable summaries of Geni objects for tool output.

import { refToId } from "../ids.js";

type Obj = Record<string, unknown>;

export interface GeniDate {
  year?: number;
  month?: number;
  day?: number;
  circa?: boolean;
  range?: string;
  end_year?: number;
  end_month?: number;
  end_day?: number;
  end_circa?: boolean;
}

function ymd(year?: number, month?: number, day?: number): string {
  if (!year) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return [String(year), month ? pad(month) : undefined, month && day ? pad(day) : undefined].filter(Boolean).join("-");
}

export function formatDate(date: GeniDate | undefined): string {
  if (!date) return "";
  const start = `${date.circa ? "c. " : ""}${ymd(date.year, date.month, date.day)}`;
  switch (date.range) {
    case "before":
      return `before ${start}`;
    case "after":
      return `after ${start}`;
    case "between":
      return `between ${start} and ${date.end_circa ? "c. " : ""}${ymd(date.end_year, date.end_month, date.end_day)}`;
    default:
      return start;
  }
}

export function formatLocation(location: Obj | undefined): string {
  if (!location) return "";
  if (typeof location.place_name === "string" && location.place_name) return location.place_name;
  return ["city", "county", "state", "country"]
    .map((k) => location[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(", ");
}

export function formatEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as Obj;
  const text = [formatDate(e.date as GeniDate | undefined), formatLocation(e.location as Obj | undefined)]
    .filter(Boolean)
    .join(", ");
  return text || undefined;
}

export interface ProfileSummary {
  id: string;
  guid?: string;
  name?: string;
  gender?: string;
  birth?: string;
  baptism?: string;
  death?: string;
  burial?: string;
  is_alive?: boolean;
  profile_url?: string;
}

export function summarizeProfile(p: Obj): ProfileSummary {
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  return dropEmpty({
    id: refToId(str("id") ?? str("url") ?? ""),
    guid: str("guid"),
    name: str("name") ?? str("display_name") ?? [str("first_name"), str("last_name")].filter(Boolean).join(" "),
    gender: str("gender"),
    birth: formatEvent(p.birth),
    baptism: formatEvent(p.baptism),
    death: formatEvent(p.death),
    burial: formatEvent(p.burial),
    is_alive: typeof p.is_alive === "boolean" ? p.is_alive : undefined,
    profile_url: str("profile_url"),
  });
}

/** Removes undefined, null, empty strings and empty arrays, recursively. */
export function dropEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropEmpty) as T;
  if (value && typeof value === "object") {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      const cleaned = dropEmpty(v);
      if (cleaned === undefined || cleaned === null || cleaned === "") continue;
      if (Array.isArray(cleaned) && cleaned.length === 0) continue;
      out[k] = cleaned;
    }
    return out as T;
  }
  return value;
}
