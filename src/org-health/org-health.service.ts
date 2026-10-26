// Purpose: one read of the company's health - setup progress, settings that contradict each other, and people who have left but still
//   lead a team or a department - plus a weekly notice to HR/Admin when there is something to fix.
// Responsibilities: get() gathers the facts and applies the rules in org-health.ts; weekly (Monday 09:50) tells every active HR/Admin of
//   a company that has any clash or any leaver still leading someone, at most once a week per person.
// Important: read-only. Fixing is done by the existing actions: POST /employees/:id/reassign-reports (move a leaver's team) and
//   POST /departments/:id/assign-head (replace a department head). Setup progress is shown but never nagged about.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, OrgListType, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { NotificationsService } from '../notifications/notifications.service';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { todayInOrgTz } from '../common/org-date';
import { managerIdsOf } from '../common/managers';
import { resolveShiftConfig, type OrganizationAttendancePrefs } from '../attendance/attendance-shift-config';
import {
  buildSetupStatus,
  findSettingsClashes,
  hasLeft,
  type LeaverDepartment,
  type LeaverTeam,
} from './org-health';

const WEEK_MS = 6 * 24 * 60 * 60 * 1000;

@Injectable()
export class OrgHealthService {
  private readonly logger = new Logger(OrgHealthService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollSettings: PayrollSettingsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async get(organizationId: string) {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true, attendancePayrollPrefs: true, epfoEstablishmentCode: true, esicEmployerCode: true, ptRegistrationNumber: true },
    });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const year = Number(today.slice(0, 4));
    const [workLocations, workSchedules, departments, designations, leaveTypes, holidaysThisYear, salaryComponents, documentRequirements, employees] = await Promise.all([
      this.scopedPrisma.workLocation.count({ where: { organizationId } }),
      this.scopedPrisma.workSchedule.count({ where: { organizationId } }),
      this.scopedPrisma.department.count({ where: { organizationId, isActive: true } }),
      this.scopedPrisma.orgListItem.count({ where: { organizationId, type: OrgListType.DESIGNATION, isActive: true } }),
      this.scopedPrisma.leaveType.count({ where: { organizationId, isActive: true } }),
      this.scopedPrisma.holiday.count({ where: { organizationId, year } }),
      this.scopedPrisma.salaryComponent.count({ where: { organizationId } }),
      this.scopedPrisma.documentRequirement.count({ where: { organizationId, isActive: true } }),
      this.scopedPrisma.user.count({ where: { organizationId, isActive: true } }),
    ]);
    const setup = buildSetupStatus({ workLocations, workSchedules, departments, designations, leaveTypes, holidaysThisYear, salaryComponents, documentRequirements, employees });

    const { settings, resolvedForCurrentMonth } = await this.payrollSettings.getWithResolvedDates(organizationId);
    const { weeklyOffs } = resolveShiftConfig(null, org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null);
    const warnings = findSettingsClashes({
      processingDate: resolvedForCurrentMonth.processingDate,
      paymentDate: resolvedForCurrentMonth.paymentDate,
      processingFixed: settings.processingDay !== 0,
      paymentFixed: settings.paymentDay !== 0,
      weeklyOffs,
      pfEnabled: settings.pfEnabled,
      esiEnabled: settings.esiEnabled,
      ptEnabled: settings.ptEnabled,
      epfoEstablishmentCode: org?.epfoEstablishmentCode ?? null,
      esicEmployerCode: org?.esicEmployerCode ?? null,
      ptRegistrationNumber: org?.ptRegistrationNumber ?? null,
      taxRegimeEmployeeChange: settings.taxRegimeEmployeeChange,
      taxRegimeCutoffMonth: settings.taxRegimeCutoffMonth,
    });

    return { setup, warnings, ...(await this.leaverLeads(organizationId, today)) };
  }

  /** Leavers who still have people reporting to them, and active departments still headed by a leaver. */
  private async leaverLeads(organizationId: string, today: string): Promise<{ leaverTeams: LeaverTeam[]; leaverDepartments: LeaverDepartment[] }> {
    const people = await this.scopedPrisma.user.findMany({
      where: { organizationId },
      select: { id: true, name: true, employeeId: true, isActive: true, employmentStatus: true, exitDate: true, reportingManagerId: true, additionalReportingManagerIds: true },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const gone = (id: string) => {
      const p = byId.get(id);
      return !!p && hasLeft(p, today);
    };
    // People still working here (a leaver's own reports who left too are not worth chasing).
    const working = people.filter((p) => !hasLeft(p, today));
    const teams = new Map<string, LeaverTeam>();
    for (const w of working) {
      for (const mid of managerIdsOf(w)) {
        if (!gone(mid)) continue;
        const m = byId.get(mid)!;
        const t = teams.get(mid) ?? { managerId: mid, name: m.name, code: m.employeeId, reports: [] };
        t.reports.push({ id: w.id, name: w.name });
        teams.set(mid, t);
      }
    }
    const departments = await this.scopedPrisma.department.findMany({
      where: { organizationId, isActive: true, departmentHeadId: { not: null } },
      select: { id: true, name: true, departmentHeadId: true },
    });
    const leaverDepartments: LeaverDepartment[] = departments
      .filter((d) => d.departmentHeadId && gone(d.departmentHeadId))
      .map((d) => ({ departmentId: d.id, name: d.name, headId: d.departmentHeadId!, headName: byId.get(d.departmentHeadId!)?.name ?? '' }));
    return { leaverTeams: [...teams.values()].sort((a, b) => b.reports.length - a.reports.length), leaverDepartments };
  }

  @Cron('50 9 * * 1')
  async weekly() {
    const orgs = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true } });
    for (const org of orgs) {
      try {
        await this.notifyForOrg(org.id);
      } catch (err) {
        this.logger.error(`Organization health notice failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  // Returns how many people were told.
  async notifyForOrg(organizationId: string): Promise<number> {
    const h = await this.get(organizationId);
    const lines: string[] = [
      ...h.warnings.map((w) => w.title),
      ...h.leaverTeams.map((t) => `${t.name} has left but ${t.reports.length} ${t.reports.length === 1 ? 'person still reports' : 'people still report'} to them`),
      ...h.leaverDepartments.map((d) => `${d.name} department is still headed by ${d.headName}, who has left`),
    ];
    if (lines.length === 0) return 0;
    const title = `${lines.length} organization setup issue${lines.length === 1 ? '' : 's'} to fix`;
    const message = lines.slice(0, 5).join('. ') + (lines.length > 5 ? `. And ${lines.length - 5} more.` : '.') + ' Open Organization to fix them.';
    const people = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    const recent = await this.scopedPrisma.notification.findMany({
      where: { organizationId, title, createdAt: { gte: new Date(Date.now() - WEEK_MS) } },
      select: { userId: true },
    });
    const already = new Set(recent.map((n) => n.userId));
    const toTell = people.filter((p) => !already.has(p.id));
    await this.notificationsService.createMany(
      toTell.map((p) => ({ organizationId, userId: p.id, title, message, category: NotificationCategory.GENERAL })),
    );
    return toTell.length;
  }
}
