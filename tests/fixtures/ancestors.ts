// Shaped like Geni's {focus, nodes} responses: profiles and unions linked by edges.
// Three generations: Jan (1) → Piet + Anna (2, 3) → Hans + Maria (4, 5); Anna's parents unknown.

export const ancestorsResponse = {
  focus: { id: "profile-1", name: "Jan Botha", gender: "male", birth: { date: { year: 1950 } } },
  nodes: {
    "profile-1": { id: "profile-1", edges: { "union-10": { rel: "child" } } },
    "union-10": {
      id: "union-10",
      edges: { "profile-2": { rel: "partner" }, "profile-3": { rel: "partner" }, "profile-1": { rel: "child" } },
    },
    "profile-3": {
      id: "profile-3",
      name: "Anna de Villiers",
      gender: "female",
      edges: { "union-10": { rel: "partner" } },
    },
    "profile-2": {
      id: "profile-2",
      name: "Piet Botha",
      gender: "male",
      birth: { date: { year: 1920, circa: true }, location: { city: "Paarl", country: "South Africa" } },
      edges: { "union-10": { rel: "partner" }, "union-20": { rel: "child" } },
    },
    "union-20": { id: "union-20", edges: { "profile-4": { rel: "partner" }, "profile-5": { rel: "partner" } } },
    "profile-4": { id: "profile-4", name: "Hans Botha", gender: "male", edges: { "union-20": { rel: "partner" } } },
    "profile-5": { id: "profile-5", name: "Maria Roux", gender: "female", edges: { "union-20": { rel: "partner" } } },
  },
};

export const immediateFamily = (focus: string, children: string[]) => {
  const union = `union-${focus.replace("profile-", "")}0`;
  return {
    focus: { id: focus, name: `Person ${focus}` },
    nodes: {
      [focus]: { id: focus, edges: { [union]: { rel: "partner" } } },
      [union]: {
        id: union,
        edges: Object.fromEntries([[focus, { rel: "partner" }], ...children.map((c) => [c, { rel: "child" }])]),
      },
      ...Object.fromEntries(children.map((c) => [c, { id: c, name: `Person ${c}` }])),
    },
  };
};
