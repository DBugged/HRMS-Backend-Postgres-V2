// Purpose: Read-only, server-side pivot of Attendance/Leave/Holiday into a month-grid + balance-strip view,
// replacing a manually-maintained Excel "Leave Tracker" (person x day grid + leave/WFH balance summary).
// Responsibilities: Resolves ADMIN/HR/MANAGER department scoping, derives one status code per (employee, day)
// from the existing Attendance row, backfilling ABSENT onto any past working day with no row at all, and
// batches the same per-employee leave-balance/comp-off primitives LeavesService.getBalance uses across the
// whole scoped list.
// Important: No new data models — everything here is a read/derivation over Attendance, Leave+LeaveType,
// Holiday, LeaveBalance, and CompOff, exactly as those already exist.
import { markPendingLeave } from './pending-leave-cells';
import { holidayInEffect } from '../holidays/holiday-in-effect';
import { getLeaveYearConfig } from '../leave-balances/leave-year-config';
import {
  leaveYearBounds,
  leaveYearLabel,
  leaveYearOf,
} from '../leave-balances/leave-year';
import { EMPLOYEE_ORDER_BY, compareEmployees } from '../common/employee-order';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  AllocationType,
  AttendanceStatus,
  LeaveStatus,
  LeaveType,
  Role,
  User,
  WorkArrangement,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { deptScopedEmployeeIds } from '../common/dept-scope';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { isEligible } from '../leave-balances/leave-eligibility';
import { CompOffService } from '../comp-offs/comp-off.service';
import { LEAVE_TYPE_CODES } from '../common/reserved-codes';
import { todayInOrgTz } from '../common/org-date';
import {
  isWeeklyOff,
  resolveShiftConfig,
  type OrganizationAttendancePrefs,
} from '../attendance/attendance-shift-config';
import {
  clampLeaveDaysToMonth,
  clampLeaveDaysToRange,
} from '../payroll/payroll-date-math';
import { QueryLeaveTrackerGridDto } from './dto/query-leave-tracker-grid.dto';
import { QueryLeaveTrackerBalancesDto } from './dto/query-leave-tracker-balances.dto';
import { ExportLeaveTrackerGridDto } from './dto/export-leave-tracker-grid.dto';
import { ExportLeaveTrackerBalancesDto } from './dto/export-leave-tracker-balances.dto';
import type { ReportColumn } from '../reports/report-export';
import type { ReportPayload } from '../reports/reports.service';

type Actor = Omit<User, 'password'>;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// YYYY-MM-DD plain-string month boundaries, same convention as every other
// date field in this codebase (Attendance.date/Holiday.date/Leave dates).
function monthBounds(
  year: number,
  month: number,
): { start: string; end: string; daysInMonth: number } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(daysInMonth)}`,
    daysInMonth,
  };
}

// Leave Without Pay: the unlimited, unpaid leave type (code LWP). It has no balance row, so it is counted from the
// approved leaves themselves.
const LWP_CODE = 'LWP';

function isCompOffType(leaveType: Pick<LeaveType, 'code'>): boolean {
  return leaveType.code === LEAVE_TYPE_CODES.COMPOFF;
}

export type LeaveTrackerCellCode =
  | 'PRESENT'
  | 'ABSENT'
  | 'HALF_DAY'
  | 'WFH'
  | 'ON_LEAVE'
  | 'COMP_OFF'
  | 'LWP'
  | 'WEEKLY_OFF'
  | 'HOLIDAY'
  | 'IN_PROGRESS'
  | 'INCOMPLETE';

// Same short codes as the frontend grid's own CELL_SHORT map
// (AttendanceGrid.tsx) — kept in sync by hand, not imported, since the
// frontend has no build-time access to backend-v2 source.
const CELL_SHORT: Record<LeaveTrackerCellCode, string> = {
  PRESENT: 'P',
  ABSENT: 'A',
  HALF_DAY: 'HD',
  WFH: 'WFH',
  ON_LEAVE: 'L',
  COMP_OFF: 'CO',
  LWP: 'LWP',
  WEEKLY_OFF: 'WO',
  HOLIDAY: 'H',
  IN_PROGRESS: 'CI',
  INCOMPLETE: 'I',
};

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class LeaveTrackerService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly compOffService: CompOffService,
  ) {}

  // ADMIN/HR: org-wide, optionally narrowed to one department via
  // `departmentId`. MANAGER: forced to their own department regardless —
  // an explicit `departmentId` that isn't their own is rejected (403),
  // never silently widened or narrowed to something else.
  private async resolveScopedEmployeeIds(
    actor: Actor,
    organizationId: string,
    departmentId?: string,
  ): Promise<string[]> {
    if (actor.role === Role.MANAGER) {
      if (departmentId && departmentId !== actor.departmentId) {
        throw new ForbiddenException('You can only view your own department.');
      }
      return deptScopedEmployeeIds(this.scopedPrisma, actor, organizationId);
    }
    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId, ...(departmentId && { departmentId }) },
      select: { id: true },
    });
    return employees.map((e) => e.id);
  }

  async grid(
    query: QueryLeaveTrackerGridDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employeeIds = await this.resolveScopedEmployeeIds(
      actor,
      organizationId,
      query.departmentId,
    );
    const { start, end, daysInMonth } = monthBounds(query.year, query.month);
    // A MANAGER's holidays are their own department's (+ company-wide);
    // ADMIN/HR sees whatever `departmentId` narrows to, or every holiday
    // when unfiltered.
    const effectiveDepartmentId =
      actor.role === Role.MANAGER ? actor.departmentId : query.departmentId;

    // `in: []` is a no-op filter (Prisma/Postgres correctly return zero
    // rows for it) — no need to branch on employeeIds.length here, unlike
    // balances() below where the loop body itself must be skipped.
    const [org, employees, attendanceRows, leaves, holidays, pendingLeaves] =
      await Promise.all([
        this.scopedPrisma.organization.findFirst({
          where: { id: organizationId },
          select: { timezone: true, attendancePayrollPrefs: true },
        }),
        this.scopedPrisma.user.findMany({
          where: { id: { in: employeeIds }, organizationId },
          select: {
            id: true,
            name: true,
            employeeId: true,
            joiningDate: true,
            departmentId: true,
            isActive: true,
            exitDate: true,
            // The department's shift decides each person's weekly offs.
            department: true,
          },
          orderBy: EMPLOYEE_ORDER_BY,
        }),
        this.scopedPrisma.attendance.findMany({
          where: {
            organizationId,
            employeeId: { in: employeeIds },
            date: { gte: start, lte: end },
          },
        }),
        this.scopedPrisma.leave.findMany({
          where: {
            organizationId,
            employeeId: { in: employeeIds },
            status: LeaveStatus.APPROVED,
            startDate: { lte: end },
            endDate: { gte: start },
          },
          include: { leaveType: true },
        }),
        this.scopedPrisma.holiday.findMany({
          where: {
            organizationId,
            AND: [holidayInEffect],
            year: query.year,
            ...(effectiveDepartmentId
              ? {
                  OR: [
                    { departmentId: effectiveDepartmentId },
                    { departmentId: null },
                  ],
                }
              : // A departmentless MANAGER gets company-wide holidays only,
                // not every department's (ADMIN/HR unfiltered = all).
                actor.role === Role.MANAGER && { departmentId: null }),
          },
        }),
        // Leave that has been applied for and is waiting for a decision: shown in the grid as leave (marked pending),
        // not as Absent, until it is approved or rejected.
        this.scopedPrisma.leave.findMany({
          where: {
            organizationId,
            employeeId: { in: employeeIds },
            status: LeaveStatus.PENDING,
            startDate: { lte: end },
            endDate: { gte: start },
          },
          include: { leaveType: true },
        }),
      ]);
    employees.sort(compareEmployees);

    // Someone appears from their joining date on: not listed for a month that ended before they joined, and no day
    // before it carries any data, whatever was recorded against it.
    const joiningOf = new Map(
      employees.map((e) => [e.id, e.joiningDate.toISOString().slice(0, 10)]),
    );
    // ...and up to their last working day: not listed for a month that began after it, and no day after it carries
    // data. A deactivated employee with no last working day on record is not listed at all.
    const exitOf = new Map(employees.map((e) => [e.id, e.exitDate ?? null]));
    for (let i = employees.length - 1; i >= 0; i--) {
      const e = employees[i];
      if ((joiningOf.get(e.id) ?? '') > end) employees.splice(i, 1);
      else if (e.exitDate && e.exitDate < start) employees.splice(i, 1);
      else if (!e.isActive && !e.exitDate) employees.splice(i, 1);
    }
    const onBooks = (employeeId: string, date: string) => {
      const joined = joiningOf.get(employeeId);
      const exit = exitOf.get(employeeId);
      return joined !== undefined && date >= joined && (!exit || date <= exit);
    };

    const leavesByEmployee = new Map<string, typeof leaves>();
    for (const leave of leaves) {
      const arr = leavesByEmployee.get(leave.employeeId) ?? [];
      arr.push(leave);
      leavesByEmployee.set(leave.employeeId, arr);
    }

    const cells: Record<string, Record<number, LeaveTrackerCellCode>> = {};
    // Hours actually worked that day, from the same Attendance row —
    // separate from `cells` (which only carries the status code) so the
    // grid can show it in a cell's tooltip without overloading the cell
    // code's own type. Only present for a day with real punch duration.
    const hours: Record<string, Record<number, number>> = {};
    // The same figure in whole minutes: clients show worked time as "8h 30m", and a decimal-hours value can't
    // give back the exact minute (8.33h -> 8h 20m vs the real 8h 19m).
    const minutes: Record<string, Record<number, number>> = {};
    for (const row of attendanceRows) {
      if (!onBooks(row.employeeId, row.date)) continue;
      const day = Number(row.date.slice(8, 10));
      if (row.workDurationMinutes > 0) {
        (hours[row.employeeId] ??= {})[day] =
          Math.round((row.workDurationMinutes / 60) * 100) / 100;
        (minutes[row.employeeId] ??= {})[day] = row.workDurationMinutes;
      }
      let code: LeaveTrackerCellCode;
      if (row.status === AttendanceStatus.HOLIDAY) {
        code = 'HOLIDAY';
      } else if (row.status === AttendanceStatus.WEEKLY_OFF) {
        code = 'WEEKLY_OFF';
      } else if (
        row.status === AttendanceStatus.ON_LEAVE ||
        row.status === AttendanceStatus.HALF_DAY
      ) {
        const employeeLeaves = leavesByEmployee.get(row.employeeId) ?? [];
        const matching = employeeLeaves.find(
          (l) => l.startDate <= row.date && l.endDate >= row.date,
        );
        // A day on Leave Without Pay is its own code, so the unpaid days stand out from paid leave (a half day on
        // LWP is also shown as LWP, since the half is what is unpaid).
        code =
          matching && isCompOffType(matching.leaveType)
            ? 'COMP_OFF'
            : matching?.leaveType.code === LWP_CODE
              ? 'LWP'
              : row.status;
      } else if (
        row.status === AttendanceStatus.PRESENT &&
        !!row.inTime &&
        !row.outTime
      ) {
        // A punch-in with no punch-out yet (stored as PRESENT): shown as Checked in until the punch-out, as in the
        // attendance calendar and the mobile app.
        code = 'IN_PROGRESS';
      } else if (row.workArrangement === WorkArrangement.WFH) {
        code = 'WFH';
      } else {
        code = row.status;
      }
      (cells[row.employeeId] ??= {})[day] = code;
    }

    // The column header names a holiday only when it applies to everyone on the grid: company-wide, or - when the grid is
    // narrowed to one department (or a Manager's own) - that department's. An optional holiday is the employee's own
    // choice, so it never marks a day for the whole column. A department-only holiday is shown per employee below.
    const columnHolidays = holidays.filter(
      (h) =>
        !h.isOptional &&
        (h.departmentId === null ||
          (!!effectiveDepartmentId &&
            h.departmentId === effectiveDepartmentId)),
    );
    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const dateStr = `${query.year}-${pad(query.month)}-${pad(day)}`;
      const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
      const holiday = columnHolidays.find((h) => h.date === dateStr);
      return {
        day,
        dow,
        dateStr,
        ...(holiday && { holidayName: holiday.name }),
      };
    });

    // As per the holiday calendar: every employee gets a Holiday cell on a day the calendar marks as a holiday for them
    // (company-wide, or their own department's; never an optional one), from their joining date, even when no
    // attendance row exists yet - so the grid and its Excel/PDF export always follow the calendar, and a department-only
    // holiday is not mistaken for a working day (or backfilled as Absent) below. A recorded row is never overridden here.
    for (const employee of employees) {
      for (const day of days) {
        if (!onBooks(employee.id, day.dateStr)) continue;
        if ((cells[employee.id] ?? {})[day.day]) continue;
        const applies = holidays.some(
          (h) =>
            h.date === day.dateStr &&
            !h.isOptional &&
            (h.departmentId === null ||
              h.departmentId === employee.departmentId),
        );
        if (applies) (cells[employee.id] ??= {})[day.day] = 'HOLIDAY';
      }
    }

    // Each person's own weekly offs (their department's shift, else the organisation's default - not always Saturday and
    // Sunday) are shown as Weekly Off from their joining date, even before the nightly job has written the row. A
    // working day strictly before today, on or after the joining date, with no Attendance row at all — no punch, no
    // leave, nothing — means the employee simply didn't show up: mark it ABSENT rather than leaving it blank. Today
    // itself is left alone (the day isn't over — someone can still check in), future days are never marked Absent, and
    // days before someone joined or after they left are never touched (blank, not Absent).
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const orgPrefs =
      (org?.attendancePayrollPrefs as OrganizationAttendancePrefs | null) ??
      null;
    const timeZone = org?.timezone ?? 'Asia/Kolkata';
    for (const employee of employees) {
      const { weeklyOffs } = resolveShiftConfig(
        employee.department,
        orgPrefs,
        timeZone,
      );
      for (const day of days) {
        if (!onBooks(employee.id, day.dateStr)) continue;
        if (cells[employee.id]?.[day.day]) continue;
        if (isWeeklyOff(day.dateStr, weeklyOffs)) {
          (cells[employee.id] ??= {})[day.day] = 'WEEKLY_OFF';
          continue;
        }
        if (day.holidayName) continue;
        if (day.dateStr >= today) continue;
        (cells[employee.id] ??= {})[day.day] = 'ABSENT';
      }
    }

    // A day covered by a leave that is still pending reads as leave (marked pending) when it would otherwise be Absent
    // or blank: the person has asked for it, so it is not an absence, but it is not approved leave either. A day
    // worked, a weekly off or a holiday is left as it is.
    const pending = markPendingLeave(
      cells,
      pendingLeaves.map((l) => ({
        employeeId: l.employeeId,
        startDate: l.startDate,
        endDate: l.endDate,
        kind: isCompOffType(l.leaveType)
          ? ('COMP_OFF' as const)
          : l.leaveType.code === LWP_CODE
            ? ('LWP' as const)
            : ('ON_LEAVE' as const),
      })),
      days,
      onBooks,
    );

    return {
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        employeeId: e.employeeId,
        // So the grid leaves the days before joining / after leaving blank instead of drawing a weekend there.
        joiningDate: joiningOf.get(e.id) ?? null,
        exitDate: e.exitDate ?? null,
      })),
      days,
      cells,
      // Days whose leave cell is a pending application (employee id -> day numbers), so clients can mark them.
      pending,
      hours,
      minutes,
    };
  }

  async balances(
    query: QueryLeaveTrackerBalancesDto,
    actor: Actor,
    organizationId: string,
  ) {
    const employeeIds = await this.resolveScopedEmployeeIds(
      actor,
      organizationId,
      query.departmentId,
    );
    if (employeeIds.length === 0) return [];

    // A chosen month ('YYYY-MM') picks the leave year that contains it and narrows leave taken / WFH days to it.
    const periodCfg = await getLeaveYearConfig(
      this.scopedPrisma,
      organizationId,
    );
    const period = query.period;
    const periodStart = period ? `${period}-01` : null;
    const periodEnd = period
      ? `${period}-${String(
          new Date(
            Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0),
          ).getUTCDate(),
        ).padStart(2, '0')}`
      : null;
    if (periodStart)
      query = { ...query, year: leaveYearOf(periodStart, periodCfg) };

    const employees = await this.scopedPrisma.user.findMany({
      where: { id: { in: employeeIds }, organizationId },
      select: {
        id: true,
        name: true,
        employeeId: true,
        // Fields isEligible() reads — evaluated in memory below.
        departmentId: true,
        employeeType: true,
        gender: true,
        joiningDate: true,
        // An inactive employee earns no leave: no balance row is created for them here (existing rows still show).
        isActive: true,
        exitDate: true,
        // Shown by the Employee Leave Stat page.
        designation: true,
        department: { select: { name: true } },
      },
      orderBy: EMPLOYEE_ORDER_BY,
    });
    employees.sort(compareEmployees);

    // With a month chosen, an employee appears only from the month they joined: someone who joined after that month
    // ended is not listed for it (the same rule as the attendance grid). With no month, the whole leave year is shown
    // and everyone stays listed.
    const joinedOn = (e: { joiningDate: Date }) =>
      e.joiningDate.toISOString().slice(0, 10);
    if (periodEnd) {
      for (let i = employees.length - 1; i >= 0; i--) {
        if (joinedOn(employees[i]) > periodEnd) employees.splice(i, 1);
        // ...and only up to the month of their last working day: a month that began after it does not list them.
        else if (periodStart && employees[i].exitDate && employees[i].exitDate! < periodStart) employees.splice(i, 1);
      }
    }

    // Fetched once for the whole loop (was once per employee) — same
    // query/ordering as LeaveBalanceService.getEligibleLeaveTypes.
    const activeLeaveTypes = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId, isActive: true },
      orderBy: { displayOrder: 'asc' },
    });
    const existingBalanceRows = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        year: query.year,
        employeeId: { in: employees.map((e) => e.id) },
      },
    });
    const existingBalanceByKey = new Map(
      existingBalanceRows.map((r) => [`${r.employeeId}:${r.leaveTypeId}`, r]),
    );

    // The query's year is a leave-year key: its dates are the leave year's, which only equal 1 Jan - 31 Dec for the
    // calendar year.
    const yearCfg = await getLeaveYearConfig(this.scopedPrisma, organizationId);
    const yearBounds = leaveYearBounds(query.year, yearCfg);
    const yearStart = yearBounds.start;
    const yearEnd = yearBounds.end;

    const balanceEmployeeIds = employees.map((e) => e.id);

    // Both hoisted out of the per-employee loop below: compOffService.available()
    // internally re-runs an org-wide sweepExpired() and a per-employee findMany
    // on every call, and attendance.count() was one query per employee — for a
    // large org this loop's cost dominates the whole grid()/balances() request.
    // availableForEmployees() sweeps once and fetches every employee's comp-off
    // rows in a single findMany; the attendance groupBy replaces N separate
    // counts with one grouped query — same final per-employee numbers either way.
    const [compOffAvailableByEmployee, wfhCounts, monthLeaves, lwpLeaves] =
      await Promise.all([
        query.lite
          ? Promise.resolve(new Map<string, number>())
          : this.compOffService.availableForEmployees(
              balanceEmployeeIds,
              organizationId,
            ),
        query.lite
          ? Promise.resolve(
              [] as { employeeId: string; _count: { _all: number } }[],
            )
          : this.scopedPrisma.attendance.groupBy({
              by: ['employeeId'],
              where: {
                organizationId,
                employeeId: { in: balanceEmployeeIds },
                date: {
                  gte: periodStart ?? yearStart,
                  lte: periodEnd ?? yearEnd,
                },
                workArrangement: WorkArrangement.WFH,
              },
              _count: { _all: true },
            }),
        // Approved leave overlapping the chosen month, to say how much of each type was taken in it.
        periodStart && periodEnd
          ? this.scopedPrisma.leave.findMany({
              where: {
                organizationId,
                employeeId: { in: balanceEmployeeIds },
                status: LeaveStatus.APPROVED,
                startDate: { lte: periodEnd },
                endDate: { gte: periodStart },
              },
              select: {
                employeeId: true,
                startDate: true,
                endDate: true,
                isHalfDay: true,
                leaveType: { select: { code: true, name: true } },
              },
            })
          : Promise.resolve([]),
        // Approved Leave Without Pay overlapping the leave year (the type has no balance, so it is summed here).
        query.lite
          ? Promise.resolve([])
          : this.scopedPrisma.leave.findMany({
              where: {
                organizationId,
                employeeId: { in: balanceEmployeeIds },
                status: LeaveStatus.APPROVED,
                leaveType: { code: LWP_CODE },
                startDate: { lte: yearEnd },
                endDate: { gte: yearStart },
              },
              select: {
                employeeId: true,
                startDate: true,
                endDate: true,
                isHalfDay: true,
              },
            }),
      ]);
    const lwpDaysByEmployee = new Map<string, number>();
    for (const l of lwpLeaves) {
      lwpDaysByEmployee.set(
        l.employeeId,
        (lwpDaysByEmployee.get(l.employeeId) ?? 0) +
          clampLeaveDaysToRange(l, yearStart, yearEnd),
      );
    }
    // employeeId -> leaveTypeCode -> { name, days } for the chosen month.
    const takenInPeriod = new Map<
      string,
      Map<string, { name: string; days: number }>
    >();
    if (periodStart) {
      const m = Number(periodStart.slice(5, 7));
      const y = Number(periodStart.slice(0, 4));
      for (const l of monthLeaves) {
        const days = clampLeaveDaysToMonth(l, m, y);
        if (days <= 0) continue;
        const byType = takenInPeriod.get(l.employeeId) ?? new Map();
        const cur = byType.get(l.leaveType.code) ?? {
          name: l.leaveType.name,
          days: 0,
        };
        cur.days += days;
        byType.set(l.leaveType.code, cur);
        takenInPeriod.set(l.employeeId, byType);
      }
    }
    const wfhDaysUsedByEmployee = new Map(
      wfhCounts.map((c) => [c.employeeId, c._count._all]),
    );
    // WFH days count only from the joining date: for anyone who joined after the range starts, a record dated before
    // they joined (an import or a manual entry) is not counted. Only those few are re-counted individually.
    const wfhFrom = periodStart ?? yearStart;
    const wfhTo = periodEnd ?? yearEnd;
    if (!query.lite) {
      const lateJoiners = employees.filter((e) => joinedOn(e) > wfhFrom);
      await Promise.all(
        lateJoiners.map(async (e) => {
          const count = await this.scopedPrisma.attendance.count({
            where: {
              organizationId,
              employeeId: e.id,
              date: { gte: joinedOn(e), lte: wfhTo },
              workArrangement: WorkArrangement.WFH,
            },
          });
          wfhDaysUsedByEmployee.set(e.id, count);
        }),
      );
    }

    // A small `for` loop of internal service calls across the scoped list
    // (never N HTTP-style round trips) — this mirrors, per employee,
    // exactly what LeavesService.getBalance does for one.
    const result: {
      employeeId: string;
      // Display code (e.g. "DP-00001"); `employeeId` above is the User.id join key.
      employeeCode: string;
      name: string;
      department: string | null;
      designation: string;
      isActive: boolean;
      leaveBalances: {
        leaveTypeCode: string;
        leaveTypeName: string;
        // Carried in from the previous leave year, and HR corrections / encashed days - together with `credited`
        // they make up the total the employee had this year.
        opening: number;
        credited: number;
        adjusted: number;
        availed: number;
        encashed: number;
        // Applied for but not yet decided.
        pending: number;
        closing: number;
      }[];
      compOffAvailable: number;
      wfhDaysUsed: number;
      // Days of approved Leave Without Pay in the leave year (not in the lite response).
      leaveWithoutPayDays: number;
      // Only when a month was asked for: leave taken in that month, by type.
      leaveTakenInPeriod?: {
        leaveTypeCode: string;
        leaveTypeName: string;
        days: number;
      }[];
    }[] = [];

    // Eligibility is evaluated once per employee up front so every missing balance row (write-on-first-
    // read for a new year/leave type) is created in one bulk insert rather than a transaction per employee.
    const balanceEligibleByEmployee = new Map<
      string,
      typeof activeLeaveTypes
    >();
    const missingPairs: { employeeId: string; leaveTypeId: string }[] = [];
    for (const employee of employees) {
      const balanceEligible = activeLeaveTypes.filter(
        (lt) =>
          isEligible(lt, employee) &&
          lt.code !== LEAVE_TYPE_CODES.COMPOFF &&
          lt.allocationType !== AllocationType.NONE &&
          lt.allocationType !== AllocationType.UNLIMITED,
      );
      balanceEligibleByEmployee.set(employee.id, balanceEligible);
      for (const lt of balanceEligible) {
        if (
          employee.isActive &&
          !existingBalanceByKey.has(`${employee.id}:${lt.id}`)
        ) {
          missingPairs.push({ employeeId: employee.id, leaveTypeId: lt.id });
        }
      }
    }
    const ensuredByKey = await this.leaveBalanceService.ensureBalanceRowsBulk(
      missingPairs,
      query.year,
      organizationId,
      employees,
      activeLeaveTypes,
    );

    // Carried-in days that lapsed unused are not part of what an employee can use, so the tracker's Closing excludes
    // them — the same figure applying for leave and encashment use. Judged as of today, or as of 31 Dec for a past
    // year; a future year has nothing lapsed yet.
    const lapsedByRow = await this.leaveBalanceService.forfeitedCarryIn(
      this.scopedPrisma,
      [...existingBalanceByKey.values(), ...ensuredByKey.values()],
      organizationId,
      new Date().toISOString().slice(0, 10) > yearEnd
        ? yearEnd
        : new Date().toISOString().slice(0, 10),
    );

    for (const employee of employees) {
      const balanceEligible = balanceEligibleByEmployee.get(employee.id)!;

      // Balances are still created for every eligible type; only the tracker's view/export skips hidden ones.
      const leaveBalances = balanceEligible
        .filter((leaveType) => leaveType.showInLeaveTracker)
        .flatMap((leaveType) => {
          const row =
            existingBalanceByKey.get(`${employee.id}:${leaveType.id}`) ??
            ensuredByKey.get(`${employee.id}:${leaveType.id}`);
          // No row for an inactive employee: nothing was ever credited to them.
          if (!row) return [];
          return [
            {
              leaveTypeCode: leaveType.code,
              leaveTypeName: leaveType.name,
              opening: row.opening,
              credited: row.credited,
              adjusted: row.adjusted,
              availed: row.availed,
              encashed: row.encashed,
              pending: row.pending,
              closing:
                Math.round(
                  (row.closing - (lapsedByRow.get(row.id) ?? 0)) * 100,
                ) / 100,
            },
          ];
        });

      const compOffAvailable = compOffAvailableByEmployee.get(employee.id) ?? 0;

      // No WFH balance/ledger model exists anywhere — this is an
      // attendance-count derivation, not a real ledger, hence the
      // `wfhDaysUsed` naming rather than "balance".
      const wfhDaysUsed = wfhDaysUsedByEmployee.get(employee.id) ?? 0;

      result.push({
        employeeId: employee.id,
        employeeCode: employee.employeeId,
        name: employee.name,
        department: employee.department?.name ?? null,
        designation: employee.designation,
        isActive: employee.isActive,
        leaveBalances,
        compOffAvailable,
        wfhDaysUsed,
        leaveWithoutPayDays:
          Math.round((lwpDaysByEmployee.get(employee.id) ?? 0) * 100) / 100,
        ...(periodStart && {
          leaveTakenInPeriod: [
            ...(takenInPeriod.get(employee.id) ?? new Map()).entries(),
          ].map(([leaveTypeCode, v]) => ({
            leaveTypeCode,
            leaveTypeName: v.name,
            days: Math.round(v.days * 100) / 100,
          })),
        }),
      });
    }

    return result;
  }

  // Reshapes grid()'s own output into a flat Employee-row / one-column-
  // per-day table for Excel/PDF export — reuses grid() itself rather than
  // re-deriving the same cell codes a second time.
  async exportGrid(
    query: ExportLeaveTrackerGridDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const { employees, days, cells } = await this.grid(
      query,
      actor,
      organizationId,
    );

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      ...days.map((day) => ({
        header: `${day.day} ${DOW_SHORT[day.dow]}`,
        key: `d${day.day}`,
        width: 8,
      })),
    ];

    const rows = employees.map((employee) => {
      const row: Record<string, unknown> = {
        employeeId: employee.employeeId,
        name: employee.name,
      };
      for (const day of days) {
        const code = cells[employee.id]?.[day.day];
        row[`d${day.day}`] = code ? CELL_SHORT[code] : '';
      }
      return row;
    });

    const monthName = new Date(
      Date.UTC(query.year, query.month - 1, 1),
    ).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

    return {
      title: 'Attendance Grid',
      subtitle: `${monthName} ${query.year}`,
      columns,
      rows,
      filename: `attendance-grid-${query.year}-${pad(query.month)}`,
    };
  }

  // Same idea as exportGrid() — reuses balances() and reshapes it into a
  // flat table. Leave-type columns are the union of every leave type any
  // scoped employee is eligible for (not just the first employee's), so no
  // employee's balance silently goes missing because their own leave-type
  // set happened to be a subset of someone else's.
  async exportBalances(
    query: ExportLeaveTrackerBalancesDto,
    actor: Actor,
    organizationId: string,
  ): Promise<ReportPayload> {
    const [balances, employeeIds] = await Promise.all([
      this.balances(query, actor, organizationId),
      this.resolveScopedEmployeeIds(actor, organizationId, query.departmentId),
    ]);
    // balances()'s own `employeeId` field is the User.id (its join key for
    // the frontend, not a human-readable code) — resolved separately here
    // since the export needs the actual employeeId (e.g. "DP-00001").
    const employees = await this.scopedPrisma.user.findMany({
      where: { id: { in: employeeIds }, organizationId },
      select: { id: true, employeeId: true },
    });
    const codeByUserId = new Map(employees.map((e) => [e.id, e.employeeId]));

    const leaveTypeCodes: string[] = [];
    for (const entry of balances) {
      for (const b of entry.leaveBalances) {
        if (!leaveTypeCodes.includes(b.leaveTypeCode)) {
          leaveTypeCodes.push(b.leaveTypeCode);
        }
      }
    }

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 24 },
      ...leaveTypeCodes.map((code) => ({
        header: `${code} (Credited/Availed/Closing)`,
        key: `lt_${code}`,
        width: 18,
      })),
      ...(query.period
        ? [
            {
              header: `Leave taken in ${query.period}`,
              key: 'leaveTakenInPeriod',
              width: 24,
            },
          ]
        : []),
      { header: 'Comp-Off Available', key: 'compOffAvailable', width: 16 },
      { header: 'Leave Without Pay', key: 'leaveWithoutPayDays', width: 16 },
      {
        header: query.period ? `WFH Days (${query.period})` : 'WFH Days Used',
        key: 'wfhDaysUsed',
        width: 14,
      },
    ];

    const rows = balances.map((entry) => {
      const row: Record<string, unknown> = {
        employeeId: codeByUserId.get(entry.employeeId) ?? '',
        name: entry.name,
        compOffAvailable: entry.compOffAvailable,
        leaveWithoutPayDays: entry.leaveWithoutPayDays,
        wfhDaysUsed: entry.wfhDaysUsed,
        leaveTakenInPeriod: (entry.leaveTakenInPeriod ?? [])
          .map((t) => `${t.leaveTypeCode} ${t.days}`)
          .join(', '),
      };
      for (const code of leaveTypeCodes) {
        const match = entry.leaveBalances.find((b) => b.leaveTypeCode === code);
        row[`lt_${code}`] = match
          ? `${match.credited}/${match.availed}/${match.closing}`
          : '';
      }
      return row;
    });

    const labelCfg = await getLeaveYearConfig(
      this.scopedPrisma,
      organizationId,
    );
    return {
      title: 'Leave & WFH Balances',
      subtitle: `Leave year ${leaveYearLabel(query.year, labelCfg)}`,
      columns,
      rows,
      filename: `leave-wfh-balances-${query.year}`,
    };
  }
}
