// Rails-style form encoding, which is what Geni's docs use for nested values:
// birth[date][year]=1900, names[de][first_name]=Mike, nicknames[0]=Jan.

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

export function flattenForm(value: Record<string, FormValue>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (prefix: string, v: FormValue): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, child);
      return;
    }
    out.push([prefix, String(v)]);
  };
  for (const [k, v] of Object.entries(value)) walk(k, v);
  return out;
}

export function encodeForm(value: Record<string, FormValue>): string {
  return new URLSearchParams(flattenForm(value)).toString();
}
