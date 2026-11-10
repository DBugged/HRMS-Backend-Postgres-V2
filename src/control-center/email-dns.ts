// Purpose: which DNS records a sending domain needs so platform email is trusted (SPF, DKIM, DMARC), and whether they exist now.
// Responsibilities: works out the provider from the server's mail settings, builds the records to publish, and looks each up over
//   public DNS. Read-only: it never changes DNS and never sends mail.
// Important: DKIM keys are issued by the mail provider, so we can only say where the record must be and whether it is there.
import { promises as dns } from 'dns';

export type DnsCheckStatus = 'ok' | 'missing' | 'attention';
export interface DnsCheck {
  key: 'spf' | 'dkim' | 'dmarc';
  label: string;
  type: 'TXT' | 'CNAME';
  host: string;
  /** What to publish. For DKIM it is a pointer to the provider, because the key comes from them. */
  value: string;
  /** True when `value` is exact and can be copied as is. */
  exact: boolean;
  status: DnsCheckStatus;
  found: string | null;
  hint: string;
}
export interface DnsReport { domain: string; provider: string; checks: DnsCheck[]; allDone: boolean; checkedAt: string }

interface Provider { name: string; spfInclude: string | null; dkimSelectors: string[]; dkimWhere: string }

function detectProvider(): Provider {
  const host = (process.env.SMTP_HOST || '').toLowerCase();
  const driver = process.env.EMAIL_DRIVER;
  if (driver === 'resend') return { name: 'Resend', spfInclude: 'amazonses.com', dkimSelectors: ['resend'], dkimWhere: 'Resend dashboard > Domains' };
  if (host.includes('gmail') || host.includes('google')) return { name: 'Google Workspace', spfInclude: '_spf.google.com', dkimSelectors: ['google'], dkimWhere: 'Google Admin > Apps > Gmail > Authenticate email' };
  if (host.includes('brevo') || host.includes('sendinblue')) return { name: 'Brevo', spfInclude: 'spf.brevo.com', dkimSelectors: ['brevo1', 'brevo2', 'mail'], dkimWhere: 'Brevo > Senders & IP > Domains' };
  if (host.includes('sendgrid')) return { name: 'SendGrid', spfInclude: 'sendgrid.net', dkimSelectors: ['s1', 's2'], dkimWhere: 'SendGrid > Settings > Sender Authentication' };
  if (host.includes('zoho')) return { name: 'Zoho Mail', spfInclude: host.includes('.in') ? 'zoho.in' : 'zoho.com', dkimSelectors: ['zoho', 'zmail'], dkimWhere: 'Zoho Mail Admin > Domains > Email Authentication' };
  if (host.includes('amazonaws') || host.includes('ses')) return { name: 'Amazon SES', spfInclude: 'amazonses.com', dkimSelectors: [], dkimWhere: 'Amazon SES > Verified identities' };
  return { name: host ? 'your mail provider' : 'not set up', spfInclude: null, dkimSelectors: ['default', 'selector1', 'selector2', 'k1', 's1', 'mail'], dkimWhere: "your mail provider's domain settings" };
}

const timeout = <T>(p: Promise<T>, ms = 4000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function txt(host: string): Promise<string[]> {
  try {
    return (await timeout(dns.resolveTxt(host))).map((c) => c.join(''));
  } catch {
    return [];
  }
}
async function cname(host: string): Promise<string[]> {
  try {
    return await timeout(dns.resolveCname(host));
  } catch {
    return [];
  }
}

export function domainOf(address: string): string {
  const raw = address.includes('<') ? address.slice(address.indexOf('<') + 1, address.indexOf('>')) : address;
  const at = raw.lastIndexOf('@');
  return at > 0 ? raw.slice(at + 1).trim().toLowerCase() : '';
}

export async function checkSenderDns(address: string, reportEmail?: string): Promise<DnsReport> {
  const domain = domainOf(address);
  const provider = detectProvider();
  const checks: DnsCheck[] = [];

  // SPF: one TXT record starting v=spf1 that lists who may send for the domain.
  const spfRecords = (await txt(domain)).filter((r) => r.toLowerCase().startsWith('v=spf1'));
  const spfValue = `v=spf1 ${provider.spfInclude ? `include:${provider.spfInclude} ` : ''}~all`;
  let spf: Pick<DnsCheck, 'status' | 'found' | 'hint'>;
  if (spfRecords.length === 0) spf = { status: 'missing', found: null, hint: 'No SPF record found. Add this TXT record at the domain root.' };
  else if (spfRecords.length > 1) spf = { status: 'attention', found: spfRecords.join('  |  '), hint: 'More than one SPF record exists. A domain may have only one: merge them into a single record.' };
  else if (provider.spfInclude && !spfRecords[0].includes(`include:${provider.spfInclude}`)) spf = { status: 'attention', found: spfRecords[0], hint: `Your SPF record does not include ${provider.spfInclude}. Add include:${provider.spfInclude} to the existing record.` };
  else spf = { status: 'ok', found: spfRecords[0], hint: 'SPF is set up.' };
  checks.push({ key: 'spf', label: 'SPF', type: 'TXT', host: domain, value: spfValue, exact: !!provider.spfInclude, ...spf });

  // DKIM: the key comes from the provider; we look for it at the usual selector names.
  let dkimFound: string | null = null;
  let dkimSelector = provider.dkimSelectors[0] ?? 'selector';
  for (const sel of provider.dkimSelectors) {
    const host = `${sel}._domainkey.${domain}`;
    const t = (await txt(host)).find((r) => /v=DKIM1|p=/i.test(r));
    const c = t ? [] : await cname(host);
    if (t || c.length) { dkimFound = t ?? c[0]; dkimSelector = sel; break; }
  }
  checks.push({
    key: 'dkim', label: 'DKIM', type: 'TXT', host: `${dkimSelector}._domainkey.${domain}`,
    value: `Copy the exact key from ${provider.dkimWhere}`, exact: false,
    status: dkimFound ? 'ok' : 'missing', found: dkimFound ? dkimFound.slice(0, 80) + (dkimFound.length > 80 ? '…' : '') : null,
    hint: dkimFound ? 'DKIM is set up.' : `No DKIM key found. Generate it in ${provider.dkimWhere} and publish it at this host.`,
  });

  // DMARC: tells receivers what to do with mail that fails SPF/DKIM. Start in monitor mode (p=none).
  const dmarc = (await txt(`_dmarc.${domain}`)).find((r) => r.toUpperCase().startsWith('V=DMARC1'));
  checks.push({
    key: 'dmarc', label: 'DMARC', type: 'TXT', host: `_dmarc.${domain}`,
    value: `v=DMARC1; p=none${reportEmail ? `; rua=mailto:${reportEmail}` : ''}`, exact: true,
    status: dmarc ? 'ok' : 'missing', found: dmarc ?? null,
    hint: dmarc ? 'DMARC is set up.' : 'No DMARC record found. Start with p=none (monitor only) and tighten later.',
  });

  return { domain, provider: provider.name, checks, allDone: checks.every((c) => c.status === 'ok'), checkedAt: new Date().toISOString() };
}
