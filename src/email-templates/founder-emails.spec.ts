import { finalizeEmailHtml, upgradePlainEmailHtml, wrapEmailShell } from './email-layout';
import { confirmEmailHtml, founderWelcomeHtml } from './founder-emails';

const shell = (body: string) =>
  wrapEmailShell(finalizeEmailHtml(body), {
    preheader: 'x',
    branding: { companyName: "D'CoreHR" },
  });

describe('founder emails', () => {
  const verifyUrl = 'https://app.example.test/verify-email?token=abc123';
  const loginUrl = 'https://app.example.test/login';

  it('the welcome email has a heading, a real confirm button, the steps and the ignore notice', () => {
    const html = shell(
      founderWelcomeHtml({ name: 'Admin Account', companyName: 'Demo Org', loginUrl, verifyUrl }),
    );
    expect(html).toContain('Confirm your email to get started');
    // A table-based button (works in Gmail/Outlook), pointing at the confirmation link.
    expect(html).toMatch(/<a href="https:\/\/app\.example\.test\/verify-email\?token=abc123"[^>]*class="btn"/);
    expect(html).toContain('Confirm my email address');
    expect(html).toContain('This link is valid for 48 hours.');
    expect(html).toContain('Complete your Organization Setup');
    expect(html).toContain("you can safely ignore this email");
    // Escapes what it is given.
    expect(
      founderWelcomeHtml({ name: '<b>x</b>', companyName: 'A & B', loginUrl, verifyUrl }),
    ).toContain('A &amp; B');
  });

  it('without confirmation required it goes straight to login', () => {
    const html = founderWelcomeHtml({ name: 'A', companyName: 'Org', loginUrl, verifyUrl: null });
    expect(html).toContain('Your account is ready');
    expect(html).toContain('Log in to your account');
    expect(html).not.toContain('verify-email');
  });

  it('the re-sent confirmation is a designed email too', () => {
    const html = shell(confirmEmailHtml({ name: 'A', verifyUrl }));
    expect(html).toContain('Confirm your email address');
    expect(html).toContain('verify-email?token=abc123');
    expect(html).toContain('class="btn"');
  });
});

describe('upgradePlainEmailHtml', () => {
  it('turns bare paragraphs into styled ones and a lone link into a button, under a heading', () => {
    const out = upgradePlainEmailHtml(
      '<p>Hello A,</p><p>Reset it below.</p><p><a href="https://x.test/r?t=1">https://x.test/r?t=1</a></p>',
      { title: 'Password reset', category: 'Account & Access' },
    );
    expect(out).toContain('Password reset');
    expect(out).toContain('Account &amp; Access'.replace('&amp;', '&'));
    expect(out).toContain('font-size:15px'); // paragraph styling
    expect(out).toContain('class="btn"');
    expect(out).toContain('Open the link');
  });

  it('keeps a link label that is words, and wraps unwrapped text in a paragraph', () => {
    const out = upgradePlainEmailHtml('<p><a href="https://x.test">Confirm now</a></p>');
    expect(out).toContain('Confirm now');
    expect(upgradePlainEmailHtml('You were marked absent.')).toContain('You were marked absent.');
  });

  it('leaves HTML that already uses components alone', () => {
    const rich = '<h1>Already designed</h1><table><tr><td>x</td></tr></table>';
    expect(upgradePlainEmailHtml(rich, { title: 'Ignored' })).toBe(rich);
  });
});
