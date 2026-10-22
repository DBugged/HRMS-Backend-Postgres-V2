// Purpose: Turn the flat list of employees into the reporting tree behind the Org Chart (web and mobile).
// Important: pure. Someone with no reporting manager - or whose manager is not in the list (left the company, or is
//   not listed) - starts a branch of their own at the top, so nobody disappears. A reporting loop (A reports to B,
//   B to A) cannot be drawn as a tree, so the first person of the loop is lifted to the top instead of hanging forever.
export interface OrgChartPerson {
  id: string;
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  reportingManagerId: string | null;
}

export interface OrgChartNode extends OrgChartPerson {
  /** Direct reports, by name. */
  children: OrgChartNode[];
  /** Everyone below this person, at any depth. */
  teamSize: number;
}

export function buildOrgChart(people: OrgChartPerson[]): OrgChartNode[] {
  const byId = new Map<string, OrgChartNode>();
  for (const p of people) byId.set(p.id, { ...p, children: [], teamSize: 0 });

  const roots: OrgChartNode[] = [];
  const attached = new Set<string>();
  const hasLoop = (node: OrgChartNode): boolean => {
    // Walk up the managers: a path that comes back to this person is a loop.
    const seen = new Set<string>([node.id]);
    let cur = node.reportingManagerId ? byId.get(node.reportingManagerId) : undefined;
    while (cur) {
      if (seen.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.reportingManagerId ? byId.get(cur.reportingManagerId) : undefined;
    }
    return false;
  };

  for (const node of byId.values()) {
    const manager = node.reportingManagerId ? byId.get(node.reportingManagerId) : undefined;
    if (!manager || manager.id === node.id) {
      roots.push(node);
    } else {
      manager.children.push(node);
      attached.add(node.id);
    }
  }
  // Anyone in a loop was attached to someone else and so never reached a root: lift the first of each loop up.
  const reachable = new Set<string>();
  const mark = (n: OrgChartNode) => {
    if (reachable.has(n.id)) return;
    reachable.add(n.id);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const node of byId.values()) {
    if (!reachable.has(node.id) && hasLoop(node)) {
      const manager = byId.get(node.reportingManagerId as string);
      if (manager) manager.children = manager.children.filter((c) => c.id !== node.id);
      roots.push(node);
      mark(node);
    }
  }

  const byName = (a: OrgChartNode, b: OrgChartNode) => a.name.localeCompare(b.name);
  const finish = (n: OrgChartNode, guard: Set<string>): number => {
    if (guard.has(n.id)) return 0;
    guard.add(n.id);
    n.children.sort(byName);
    n.teamSize = n.children.reduce((sum, c) => sum + 1 + finish(c, guard), 0);
    return n.teamSize;
  };
  const guard = new Set<string>();
  roots.sort(byName).forEach((r) => finish(r, guard));
  return roots;
}
