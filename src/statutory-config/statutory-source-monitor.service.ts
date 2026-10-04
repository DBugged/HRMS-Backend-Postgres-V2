// Purpose: Periodically re-reads the official pages the statutory notes cite and records whether each still carries
//   the figures the note relies on (see statutory-source-monitor.ts).
// Responsibilities: runs once shortly after start-up and then weekly; keeps the latest result per source in memory
//   and serves it to the Statutory Compliance Center. Read-only: it never edits a configuration version.
// Important: a failed fetch is reported as UNREACHABLE, never as a problem with the note. Results are in memory, so
//   a restart simply re-checks.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  MONITORED_SOURCES,
  judgePage,
  type MonitoredSource,
  type SourceCheckResult,
} from './statutory-source-monitor';

const FETCH_TIMEOUT_MS = 15_000;
const STARTUP_DELAY_MS = 30_000;

@Injectable()
export class StatutorySourceMonitorService implements OnModuleInit {
  private readonly logger = new Logger(StatutorySourceMonitorService.name);
  private results = new Map<string, SourceCheckResult>();

  onModuleInit() {
    // Not in tests, and not blocking boot.
    if (process.env.NODE_ENV === 'test') return;
    const timer = setTimeout(() => void this.checkAll(), STARTUP_DELAY_MS);
    timer.unref();
  }

  getResults(): SourceCheckResult[] {
    return MONITORED_SOURCES.map(
      (s) =>
        this.results.get(s.key) ?? {
          key: s.key,
          module: s.module,
          label: s.label,
          url: s.url,
          status: 'UNREACHABLE' as const,
          checkedAt: '',
        },
    ).filter((r) => r.checkedAt !== '');
  }

  // Sundays 03:00.
  @Cron('0 3 * * 0')
  async checkAll(): Promise<void> {
    for (const source of MONITORED_SOURCES) {
      this.results.set(source.key, await this.check(source));
    }
  }

  private async fetchPage(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; HRMS-source-check)',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  private async check(source: MonitoredSource): Promise<SourceCheckResult> {
    const html = await this.fetchPage(source.url);
    const status = judgePage(html, source.mustMatch);
    if (status === 'CHANGED') {
      this.logger.warn(
        `Statutory source "${source.label}" no longer carries the expected figures — re-check the ${source.module} note.`,
      );
    }
    return {
      key: source.key,
      module: source.module,
      label: source.label,
      url: source.url,
      status,
      checkedAt: new Date().toISOString(),
    };
  }
}
