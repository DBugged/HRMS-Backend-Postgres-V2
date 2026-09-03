// Purpose: Read-only, server-side pivot of Attendance/Leave/Holiday into a month-grid + balance-strip view,
// replacing a manually-maintained Excel "Leave Tracker" (person x day grid + leave/WFH balance summary).
// Responsibilities: Resolves ADMIN/HR/MANAGER department scoping, derives one status code per (employee, day)
// from the existing Attendance row, backfilling ABSENT onto any past working day with no row at all, and
// batches the same per-employee leave-balance/comp-off primitives LeavesService.getBalance uses across the
// whole scoped list.
// Important: No new data models — everything here is a read/derivation over Attendance, Leave+LeaveType,
// Holiday, LeaveBalance, and CompOff, exactly as those already exist.
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
import { CompOffService } from '../comp-offs/comp-off.service';
import { LEAVE_TYPE_CODES } from '../common/reserved-codes';
import { QueryLeaveTrackerGridDto } from './dto/query-leave-tracker-grid.dto';
import { QueryLeaveTrackerBalancesDto } from './dto/query-leave-tracker-balances.dto';

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

function isCompOffType(leaveType: Pick<LeaveType, 'code'>): boolean {
  return leaveType.code === LEAVE_TYPE_CODES.COMPOFF;
}

// Same todayStr() convention as attendance.service.ts/leaves.service.ts —
// plain-string comparison against the YYYY-MM-DD date fields, no timezone
// math needed since both sides are already UTC-normalized this way.
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export type LeaveTrackerCellCode =
  | 'PRESENT'
  | 'ABSENT'
  | 'HALF_DAY'
  | 'WFH'
  | 'ON_LEAVE'
  | 'COMP_OFF'
  | 'WEEKLY_OFF'
  | 'HOLIDAY';

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
    const [employees, attendanceRows, leaves, holidays] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { id: { in: employeeIds }, organizationId },
        select: { id: true, name: true, employeeId: true, joiningDate: true },
        orderBy: { name: 'asc' },
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
          year: query.year,
          ...(effectiveDepartmentId && {
            OR: [
              { departmentId: effectiveDepartmentId },
              { departmentId: null },
            ],
          }),
        },
      }),
    ]);

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
    for (const row of attendanceRows) {
      const day = Number(row.date.slice(8, 10));
      if (row.workDurationMinutes > 0) {
        (hours[row.employeeId] ??= {})[day] =
          Math.round((row.workDurationMinutes / 60) * 10) / 10;
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
        code =
          matching && isCompOffType(matching.leaveType)
            ? 'COMP_OFF'
            : row.status;
      } else if (row.workArrangement === WorkArrangement.WFH) {
        code = 'WFH';
      } else {
        code = row.status;
      }
      (cells[row.employeeId] ??= {})[day] = code;
    }

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const dateStr = `${query.year}-${pad(query.month)}-${pad(day)}`;
      const dow = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
      const holiday = holidays.find((h) => h.date === dateStr);
      return {
        day,
        dow,
        dateStr,
        ...(holiday && { holidayName: holiday.name }),
      };
    });

    // A working day (not a weekend/holiday) strictly before today, on or
    // after the employee's own joining date, with no Attendance row at all
    // — no punch, no leave, nothing — means the employee simply didn't show
    // up: mark it ABSENT rather than leaving it blank. Today itself is left
    // alone (the day isn't over — someone can still check in), future days
    // are never touched, and days before someone joined are never touched
    // either (they weren't an employee yet — blank, not Absent).
    const today = todayStr();
    for (const employee of employees) {
      const joiningDateStr = employee.joiningDate.toISOString().slice(0, 10);
      for (const day of days) {
        if (day.dow === 0 || day.dow === 6 || day.holidayName) continue;
        if (day.dateStr >= today) continue;
        if (day.dateStr < joiningDateStr) continue;
        const existing = cells[employee.id]?.[day.day];
        if (existing) continue;
        (cells[employee.id] ??= {})[day.day] = 'ABSENT';
      }
    }

    return {
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        employeeId: e.employeeId,
      })),
      days,
      cells,
      hours,
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

    const employees = await this.scopedPrisma.user.findMany({
      where: { id: { in: employeeIds }, organizationId },
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: 'asc' },
    });

    const yearStart = `${query.year}-01-01`;
    const yearEnd = `${query.year}-12-31`;

    // A small `for` loop of internal service calls across the scoped list
    // (never N HTTP-style round trips) — this mirrors, per employee,
    // exactly what LeavesService.getBalance does for one.
    const result: {
      employeeId: string;
      name: string;
      leaveBalances: {
        leaveTypeCode: string;
        leaveTypeName: string;
        credited: number;
        availed: number;
        closing: number;
      }[];
      compOffAvailable: number;
      wfhDaysUsed: number;
    }[] = [];

    for (const employee of employees) {
      const eligible = await this.leaveBalanceService.getEligibleLeaveTypes(
        employee.id,
        organizationId,
      );
      const balanceEligible = eligible.filter(
        (lt) =>
          lt.code !== LEAVE_TYPE_CODES.COMPOFF &&
          lt.allocationType !== AllocationType.NONE &&
          lt.allocationType !== AllocationType.UNLIMITED,
      );

      const leaveBalances = await this.scopedPrisma.$transaction(async (tx) => {
        const rows: {
          leaveTypeCode: string;
          leaveTypeName: string;
          credited: number;
          availed: number;
          closing: number;
        }[] = [];
        for (const leaveType of balanceEligible) {
          const row = await this.leaveBalanceService.ensureBalanceRow(
            tx,
            employee.id,
            leaveType.id,
            query.year,
            organizationId,
          );
          rows.push({
            leaveTypeCode: leaveType.code,
            leaveTypeName: leaveType.name,
            credited: row.credited,
            availed: row.availed,
            closing: row.closing,
          });
        }
        return rows;
      });

      const compOffAvailable = await this.compOffService.available(
        employee.id,
        organizationId,
      );

      // No WFH balance/ledger model exists anywhere — this is an
      // attendance-count derivation, not a real ledger, hence the
      // `wfhDaysUsed` naming rather than "balance".
      const wfhDaysUsed = await this.scopedPrisma.attendance.count({
        where: {
          organizationId,
          employeeId: employee.id,
          date: { gte: yearStart, lte: yearEnd },
          workArrangement: WorkArrangement.WFH,
        },
      });

      result.push({
        employeeId: employee.id,
        name: employee.name,
        leaveBalances,
        compOffAvailable,
        wfhDaysUsed,
      });
    }

    return result;
  }
}
