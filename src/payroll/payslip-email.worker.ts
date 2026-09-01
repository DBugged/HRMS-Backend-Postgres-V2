import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { redisEnabled, getRedisUrl } from '../common/redis.config';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayslipPdfService } from './payslip-pdf.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import {
  PAYSLIP_EMAIL_QUEUE_NAME,
  PayslipEmailJobData,
} from './payslip-email-queue.service';

// Consumer half — see payslip-email-queue.service.ts for why this is a
// plain BullMQ Worker rather than @nestjs/bullmq's @Processor(). Lives in
// PayrollModule (not its own module) purely so it can constructor-inject
// PayslipPdfService and EmailService without a circular module import —
// both are already providers/exports of modules PayrollModule imports.
//
// Runs outside any request context, so there's no "current org" — every
// query here filters by the organizationId carried in the job payload
// explicitly, same as every other tenant-scoped query in this codebase.
@Injectable()
export class PayslipEmailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PayslipEmailWorker.name);
  private worker: Worker<PayslipEmailJobData> | null = null;
  // See PayslipEmailQueueService's connection field — same BullMQ gotcha:
  // worker.close() doesn't close an externally-supplied `connection`.
  private connection: IORedis | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payslipPdfService: PayslipPdfService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  onModuleInit() {
    if (!redisEnabled()) return;
    this.connection = new IORedis(getRedisUrl(), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<PayslipEmailJobData>(
      PAYSLIP_EMAIL_QUEUE_NAME,
      (job) => this.process(job),
      { connection: this.connection },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Payslip email job ${job?.id} failed after ${job?.attemptsMade} attempt(s): ${err.message}`,
      );
    });
  }

  private async process(job: Job<PayslipEmailJobData>) {
    const { runId, organizationId } = job.data;
    const run = await this.scopedPrisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
    });
    if (!run) return; // Run (or its org) no longer exists — nothing to send.

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: run.employeeId, organizationId },
    });
    if (!employee) return;

    const title = `Payslip for ${run.month}/${run.year}`;
    const { buffer, filename } =
      await this.payslipPdfService.buildPayslipPdfBuffer(
        run.id,
        organizationId,
      );
    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      'PAYSLIP_ISSUED',
      { employeeName: employee.name, month: String(run.month), year: String(run.year), netPay: String(run.netPay) },
      { subject: title, html: `Your salary for ${run.month}/${run.year} has been paid. Net pay: ${run.netPay}.` },
    );
    await this.emailService.send({
      to: employee.email,
      subject: rendered.subject,
      html: rendered.html,
      attachments: [{ filename, content: buffer }],
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.connection?.quit();
  }
}
