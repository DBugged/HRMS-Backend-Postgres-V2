import { AUTOMATION_TEMPLATES, findTemplateGaps } from './automation-templates';

const allLetters = AUTOMATION_TEMPLATES.filter((t) => t.kind === 'letter').map((t) => ({ key: t.key, isActive: true }));

describe('findTemplateGaps', () => {
  it('finds nothing when every letter exists and is on, and emails are on or never edited', () => {
    expect(findTemplateGaps(allLetters, [])).toEqual([]);
  });

  it('reports a missing letter template', () => {
    const gaps = findTemplateGaps(allLetters.filter((l) => l.key !== 'confirmationLetter'), []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ key: 'confirmationLetter', problem: 'MISSING' });
  });

  it('reports a switched-off letter template', () => {
    const gaps = findTemplateGaps(allLetters.map((l) => (l.key === 'relievingLetter' ? { ...l, isActive: false } : l)), []);
    expect(gaps).toMatchObject([{ key: 'relievingLetter', problem: 'OFF' }]);
  });

  it('treats a missing email template as fine (the built-in wording is used) but a switched-off one as a gap', () => {
    expect(findTemplateGaps(allLetters, [])).toEqual([]);
    const gaps = findTemplateGaps(allLetters, [{ occasionKey: 'EXIT_DOCUMENTS_PACK', isActive: false }]);
    expect(gaps).toMatchObject([{ key: 'EXIT_DOCUMENTS_PACK', kind: 'email', problem: 'OFF' }]);
  });
});
