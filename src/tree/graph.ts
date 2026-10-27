// Parses the `{focus, nodes}` structure returned by profile/immediate-family and
// profile/ancestors. Each node carries `edges: { "<other id>": { rel: "partner" | "child" } }`,
// linking profiles to the unions they belong to. The docs do not describe this
// structure, so the parser reads edges from both sides and tolerates either missing.

import { refToId } from "../ids.js";

export type GeniNode = Record<string, unknown> & {
  id?: string;
  edges?: Record<string, { rel?: string } | undefined>;
};

export interface FamilyResponse {
  focus?: GeniNode;
  nodes?: Record<string, GeniNode>;
}

export interface UnionLinks {
  readonly partners: string[];
  readonly children: string[];
}

export class FamilyGraph {
  readonly profiles = new Map<string, GeniNode>();
  readonly unions = new Map<string, UnionLinks>();
  readonly focusId: string | undefined;

  constructor(response: FamilyResponse) {
    const nodes: Record<string, GeniNode> = { ...(response.nodes ?? {}) };
    const focus = response.focus;
    this.focusId = focus?.id ? refToId(focus.id) : undefined;
    if (focus && this.focusId) nodes[this.focusId] = { ...focus, ...(nodes[this.focusId] ?? {}) };

    for (const [key, node] of Object.entries(nodes)) {
      const id = refToId(node.id ?? key);
      if (id.startsWith("profile-")) this.profiles.set(id, node);
      else if (id.startsWith("union-")) this.union(id);
    }
    for (const [key, node] of Object.entries(nodes)) {
      const id = refToId(node.id ?? key);
      for (const [otherRef, edge] of Object.entries(node.edges ?? {})) {
        const other = refToId(otherRef);
        const rel = edge?.rel;
        if (rel !== "partner" && rel !== "child") continue;
        if (id.startsWith("union-") && other.startsWith("profile-")) this.link(id, other, rel);
        else if (id.startsWith("profile-") && other.startsWith("union-")) this.link(other, id, rel);
      }
    }
  }

  private union(id: string): UnionLinks {
    let links = this.unions.get(id);
    if (!links) {
      links = { partners: [], children: [] };
      this.unions.set(id, links);
    }
    return links;
  }

  private link(unionId: string, profileId: string, rel: "partner" | "child"): void {
    const list = rel === "partner" ? this.union(unionId).partners : this.union(unionId).children;
    if (!list.includes(profileId)) list.push(profileId);
  }

  /** Unions in which the profile is a child, i.e. their parents' couples. */
  parentUnions(profileId: string): string[] {
    return [...this.unions].filter(([, u]) => u.children.includes(profileId)).map(([id]) => id);
  }

  /** Unions in which the profile is a partner. */
  ownUnions(profileId: string): string[] {
    return [...this.unions].filter(([, u]) => u.partners.includes(profileId)).map(([id]) => id);
  }

  parents(profileId: string): string[] {
    return unique(this.parentUnions(profileId).flatMap((u) => this.unions.get(u)?.partners ?? []));
  }

  children(profileId: string): string[] {
    return unique(this.ownUnions(profileId).flatMap((u) => this.unions.get(u)?.children ?? []));
  }

  partners(profileId: string): string[] {
    return unique(this.ownUnions(profileId).flatMap((u) => this.unions.get(u)?.partners ?? [])).filter((p) => p !== profileId);
  }

  siblings(profileId: string): string[] {
    return unique(this.parentUnions(profileId).flatMap((u) => this.unions.get(u)?.children ?? [])).filter((p) => p !== profileId);
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
