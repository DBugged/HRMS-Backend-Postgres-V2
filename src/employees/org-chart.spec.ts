import { buildOrgChart, type OrgChartPerson } from './org-chart';

const p = (id: string, name: string, manager: string | null): OrgChartPerson => ({
  id,
  employeeId: `E-${id}`,
  name,
  designation: '',
  department: '',
  reportingManagerId: manager,
});

describe('buildOrgChart', () => {
  it('nests people under their reporting manager and counts every level below', () => {
    const tree = buildOrgChart([p('1', 'Asha', null), p('2', 'Bala', '1'), p('3', 'Chitra', '2'), p('4', 'Dev', '1')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Asha');
    expect(tree[0].teamSize).toBe(3);
    expect(tree[0].children.map((c) => c.name)).toEqual(['Bala', 'Dev']);
    expect(tree[0].children[0].teamSize).toBe(1);
  });

  it('puts someone whose manager is not in the list at the top', () => {
    const tree = buildOrgChart([p('1', 'Asha', null), p('2', 'Bala', 'gone')]);
    expect(tree.map((n) => n.name)).toEqual(['Asha', 'Bala']);
  });

  it('keeps everyone when two people report to each other', () => {
    const tree = buildOrgChart([p('1', 'Asha', '2'), p('2', 'Bala', '1')]);
    const names: string[] = [];
    const walk = (n: (typeof tree)[number]) => { names.push(n.name); n.children.forEach(walk); };
    tree.forEach(walk);
    expect(names.sort()).toEqual(['Asha', 'Bala']);
  });

  it('treats someone who reports to themselves as a top-level person', () => {
    expect(buildOrgChart([p('1', 'Asha', '1')]).map((n) => n.name)).toEqual(['Asha']);
  });
});
