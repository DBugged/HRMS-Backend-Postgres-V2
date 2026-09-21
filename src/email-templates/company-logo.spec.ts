import { companyLogoImgTag, logoVersion } from './company-logo';

const ORG = '11111111-1111-4111-8111-111111111111';

describe('companyLogoImgTag', () => {
  const old = process.env.BACKEND_PUBLIC_URL;
  afterEach(() => {
    if (old === undefined) delete process.env.BACKEND_PUBLIC_URL;
    else process.env.BACKEND_PUBLIC_URL = old;
  });

  it('returns empty when no logo is set', () => {
    expect(companyLogoImgTag(ORG, null)).toBe('');
  });
  it('uses the durable public URL with a version hash, not a signed token', () => {
    process.env.BACKEND_PUBLIC_URL = 'https://api.example.com/';
    const key = `${ORG}/branding/logo.png`;
    const tag = companyLogoImgTag(ORG, key, 'Acme "Co" <x>');
    expect(tag).toContain(
      `src="https://api.example.com/public/branding/${ORG}/email-logo?v=${logoVersion(key)}"`,
    );
    expect(tag).not.toContain('/files/');
    expect(tag).toContain('alt="Acme &quot;Co&quot; &lt;x&gt;"');
    expect(tag).toContain('max-height:48px');
  });
  it('changes the version when the key changes', () => {
    expect(logoVersion('a.png')).not.toBe(logoVersion('b.png'));
  });
});
