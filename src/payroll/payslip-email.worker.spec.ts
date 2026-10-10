import { PayslipEmailWorker } from './payslip-email.worker';

type Row = Record<string, any>;

function build(
  run: Row | null,
  employee: Row | null = { id: 'e1', name: 'Asha', email: 'a@x.com' },
) {
  const sent: Row[] = [];
  const updates: Row[] = [];
  const prisma = {
    payrollRun: {
      findFirst: async () => run,
      updateMany: async (a: Row) => {
        updates.push(a);
        return { count: 1 };
      },
    },
    user: { findFirst: async () => employee },
  };
  const worker = new PayslipEmailWorker(
    prisma as never,
    {
      buildPayslipPdfBuffer: async () => ({
        buffer: Buffer.from('%PDF'),
        filename: 'payslip.pdf',
      }),
    } as never,
    { send: async (m: Row) => sent.push(m) } as never,
    {
      renderOccasion: async () => ({ subject: 'Payslip', html: '<p>hi</p>' }),
    } as never,
  );
  const process = (w: PayslipEmailWorker) =>
    (w as unknown as { process: (j: Row) => Promise<void> }).process({
      data: { runId: 'r1', organizationId: 'org' },
    });
  return { worker, sent, updates, process: () => process(worker) };
}

const paid = (over: Row = {}) => ({
  id: 'r1',
  employeeId: 'e1',
  month: 9,
  year: 2026,
  netPay: 37000,
  status: 'PAID',
  payslipEmailSentAt: null,
  ...over,
});

describe('payslip e-mail worker', () => {
  it('sends the payslip PDF to the employee and records that it went out', async () => {
    const { sent, updates, process } = build(paid());
    await process();
    expect(sent).toEqual([
      expect.objectContaining({
        to: 'a@x.com',
        attachments: [expect.objectContaining({ filename: 'payslip.pdf' })],
      }),
    ]);
    expect(updates[0].data.payslipEmailSentAt).toBeInstanceOf(Date);
  });

  it('never sends for a run that is no longer Paid (it was unlocked while the job waited)', async () => {
    for (const status of ['CALCULATED', 'LOCKED', 'APPROVED']) {
      const { sent, process } = build(paid({ status }));
      await process();
      expect(sent).toHaveLength(0);
    }
  });

  it('a redelivered job does not send the same payslip twice', async () => {
    const { sent, process } = build(paid({ payslipEmailSentAt: new Date() }));
    await process();
    expect(sent).toHaveLength(0);
  });

  it('a run or employee that no longer exists is skipped quietly', async () => {
    const a = build(null);
    await expect(a.process()).resolves.toBeUndefined();
    const b = build(paid(), null);
    await b.process();
    expect(b.sent).toHaveLength(0);
  });

  it('is not marked as sent when the e-mail itself fails, so the queue can retry it', async () => {
    const { worker, updates } = build(paid());
    (worker as unknown as Row).emailService = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    await expect(
      (worker as unknown as { process: (j: Row) => Promise<void> }).process({
        data: { runId: 'r1', organizationId: 'org' },
      }),
    ).rejects.toThrow(/smtp down/);
    expect(updates).toHaveLength(0);
  });
});
