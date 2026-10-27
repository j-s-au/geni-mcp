// Numbers an ancestors graph Ahnentafel-style: focus = 1, father = 2n, mother = 2n + 1.

import type { FamilyGraph } from "./graph.js";
import { summarizeProfile, type ProfileSummary } from "./summarize.js";

export interface AhnentafelRow extends ProfileSummary {
  ahnentafel: number;
  generation: number;
  note?: string;
}

export interface AhnentafelResult {
  rows: AhnentafelRow[];
  /** Ahnentafel numbers in the requested range with no profile on Geni (child known). */
  missing: number[];
}

export function generationOf(n: number): number {
  return Math.floor(Math.log2(n)) + 1;
}

export function buildAhnentafel(graph: FamilyGraph, generations: number): AhnentafelResult {
  const rows: AhnentafelRow[] = [];
  const missing: number[] = [];
  if (!graph.focusId) return { rows, missing };

  const seen = new Set<string>();
  const queue: Array<[number, string]> = [[1, graph.focusId]];
  while (queue.length > 0) {
    const [n, id] = queue.shift()!;
    const node = graph.profiles.get(id) ?? { id };
    const row: AhnentafelRow = { ahnentafel: n, generation: generationOf(n), ...summarizeProfile(node) };
    if (seen.has(id)) row.note = "pedigree collapse: this person already appears at another number";
    rows.push(row);
    if (seen.has(id)) continue;
    seen.add(id);
    if (generationOf(n) >= generations) continue;

    const { father, mother, note } = assignParents(graph, id);
    if (note) row.note = note;
    if (father) queue.push([2 * n, father]);
    else missing.push(2 * n);
    if (mother) queue.push([2 * n + 1, mother]);
    else missing.push(2 * n + 1);
  }
  rows.sort((a, b) => a.ahnentafel - b.ahnentafel);
  return { rows, missing: missing.sort((a, b) => a - b) };
}

function assignParents(graph: FamilyGraph, id: string): { father?: string; mother?: string; note?: string } {
  const unions = graph.parentUnions(id);
  const notes: string[] = [];
  if (unions.length > 1) notes.push(`has ${unions.length} parent couples on Geni (e.g. birth and adoptive); used the first`);
  const parents = unions.length ? (graph.unions.get(unions[0]!)?.partners ?? []) : [];

  let father: string | undefined;
  let mother: string | undefined;
  const unknown: string[] = [];
  for (const p of parents) {
    const gender = String(graph.profiles.get(p)?.gender ?? "").toLowerCase();
    if (gender === "male" && !father) father = p;
    else if (gender === "female" && !mother) mother = p;
    else unknown.push(p);
  }
  for (const p of unknown) {
    if (!father) father = p;
    else if (!mother) mother = p;
  }
  if (unknown.length) notes.push("a parent's gender is not recorded, so father/mother placement is a guess");
  return { father, mother, note: notes.join("; ") || undefined };
}
