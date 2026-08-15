// One-shot import of the single real organization + its data from the old
// Express/Sequelize/MySQL backend into backend-v2's Postgres DB. Run once;
// not idempotent (wipes backend-v2's tenant data first). See conversation
// for the audit that found exactly one real org ("D'Bugged Programmers")
// plus ~9 orphaned test orgs left over from repeated registration testing —
// only the real org is migrated.

require('dotenv').config();
const mysql = require('mysql2/promise');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const REAL_ORG_ID = 'cf18c713-9395-485c-a40a-39368724d38d';

const ROLE_MAP = {
  administrator: 'ADMIN',
  hr_admin: 'HR',
  payroll_executive: 'HR',
  payroll_manager: 'HR',
  department_head: 'MANAGER',
  employee: 'EMPLOYEE',
  finance: 'HR',
  auditor: 'HR',
};

const EMPLOYMENT_STATUS_MAP = {
  Onboarding: 'ONBOARDING',
  Probation: 'PROBATION',
  'Extended Probation': 'EXTENDED_PROBATION',
  Confirmed: 'CONFIRMED',
  'Notice Period': 'NOTICE_PERIOD',
  Resigned: 'RESIGNED',
  'Released / Relieved': 'RELEASED',
  Terminated: 'TERMINATED',
  Absconded: 'ABSCONDED',
  'On Hold': 'ON_HOLD',
};

const GENDER_MAP = { Male: 'MALE', Female: 'FEMALE', Other: 'OTHER' };
const PROBATION_STATUS_MAP = { pending: 'PENDING', confirmed: 'CONFIRMED', extended: 'EXTENDED' };
const SALARY_COMPONENT_TYPE_MAP = { earning: 'EARNING', deduction: 'DEDUCTION' };
const CALC_TYPE_MAP = { fixed: 'FIXED', percentage: 'PERCENTAGE', formula: 'FORMULA', manual: 'MANUAL' };
const PAY_FREQUENCY_MAP = { monthly: 'MONTHLY', quarterly: 'QUARTERLY', half_yearly: 'HALF_YEARLY', yearly: 'YEARLY' };
const ALLOCATION_TYPE_MAP = {
  fixed_annual: 'FIXED_ANNUAL',
  prorated_on_joining: 'PRORATED_ON_JOINING',
  earned_monthly: 'EARNED_MONTHLY',
  unlimited: 'UNLIMITED',
  none: 'NONE',
};
const ACCRUAL_FREQUENCY_MAP = {
  yearly: 'YEARLY',
  half_yearly: 'HALF_YEARLY',
  quarterly: 'QUARTERLY',
  monthly: 'MONTHLY',
  bi_monthly: 'BI_MONTHLY',
};
const STATUTORY_MODULE_MAP = {
  pf: 'PF',
  esi: 'ESI',
  pt: 'PT',
  lwf: 'LWF',
  gratuity: 'GRATUITY',
  bonus: 'BONUS',
  nps: 'NPS',
  payroll_calendar: 'PAYROLL_CALENDAR',
  rounding: 'ROUNDING',
};
const HOLIDAY_TYPE_MAP = { national: 'NATIONAL', state: 'STATE', regional: 'REGIONAL', company: 'COMPANY', optional: 'OPTIONAL' };
const TIMELINE_CATEGORY_MAP = {
  recruitment: 'RECRUITMENT',
  employment: 'EMPLOYMENT',
  organization: 'ORGANIZATION',
  payroll: 'PAYROLL',
  attendance_leave: 'ATTENDANCE_LEAVE',
  performance: 'PERFORMANCE',
  compliance: 'COMPLIANCE',
  exit: 'EXIT',
};
const FENCE_TYPE_MAP = { circle: 'CIRCLE', rectangle: 'RECTANGLE', polygon: 'POLYGON' };
const AMOUNT_BASIS_MAP = { monthly: 'MONTHLY', annual: 'ANNUAL' };
const AUDIT_MODULE_MAP = {
  auth: 'AUTH',
  employee: 'EMPLOYEE',
  attendance: 'ATTENDANCE',
  leave: 'LEAVE',
  payroll: 'PAYROLL',
  department: 'DEPARTMENT',
  document: 'DOCUMENT',
  holiday: 'HOLIDAY',
  notification: 'NOTIFICATION',
  organization: 'ORGANIZATION',
};

// mysql2 returns MySQL DATE columns as JS Date objects at local midnight
// (not UTC) — .toISOString() would shift them back a day in any
// timezone ahead of UTC, so this reads the LOCAL calendar date instead of
// converting through UTC.
function toDateStr(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function jsonOrDefault(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

async function main() {
  const mysqlConn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database: 'dbugged_hrms',
  });
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  async function q(sql, params = []) {
    const [rows] = await mysqlConn.execute(sql, params);
    return rows;
  }

  try {
    console.log('Wiping backend-v2 tenant data...');
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "organizations" CASCADE');

    console.log('Reading legacy org + users...');
    const [org] = await q('SELECT * FROM organization WHERE _id = ?', [REAL_ORG_ID]);
    const users = await q('SELECT * FROM users WHERE organizationId = ?', [REAL_ORG_ID]);
    const departments = await q('SELECT * FROM departments WHERE organizationId = ?', [REAL_ORG_ID]);
    const workLocations = await q('SELECT * FROM work_locations WHERE organizationId = ?', [REAL_ORG_ID]);
    const salaryComponents = await q('SELECT * FROM salary_components WHERE organizationId = ?', [REAL_ORG_ID]);
    const leaveTypes = await q('SELECT * FROM leave_types WHERE organizationId = ?', [REAL_ORG_ID]);
    const statutoryConfigVersions = await q('SELECT * FROM statutory_config_versions WHERE organizationId = ?', [REAL_ORG_ID]);
    const holidays = await q('SELECT * FROM holidays WHERE organizationId = ?', [REAL_ORG_ID]);
    const employeeTimeline = await q('SELECT * FROM employee_timeline WHERE organizationId = ?', [REAL_ORG_ID]);
    const leaveBalances = await q('SELECT * FROM leave_balances WHERE organizationId = ?', [REAL_ORG_ID]);
    const payrollSettingsRows = await q('SELECT * FROM payroll_settings WHERE organizationId = ?', [REAL_ORG_ID]);
    const employeeSalaryComponents = await q('SELECT * FROM employee_salary_components WHERE organizationId = ?', [REAL_ORG_ID]);
    const auditLogs = await q('SELECT * FROM audit_logs WHERE organizationId = ?', [REAL_ORG_ID]);

    if (!org) throw new Error(`Real org ${REAL_ORG_ID} not found in legacy DB`);

    console.log(
      `Found: 1 org, ${users.length} users, ${departments.length} departments, ${workLocations.length} work locations, ` +
        `${salaryComponents.length} salary components, ${leaveTypes.length} leave types, ${statutoryConfigVersions.length} statutory config versions, ` +
        `${holidays.length} holidays, ${employeeTimeline.length} timeline events, ${leaveBalances.length} leave balances, ` +
        `${payrollSettingsRows.length} payroll settings, ${employeeSalaryComponents.length} employee salary components, ${auditLogs.length} audit logs.`,
    );

    // --- Pass 1: Organization ---
    console.log('Inserting organization...');
    await prisma.organization.create({
      data: {
        id: org._id,
        name: org.companyName || 'D\'Bugged Programmers',
        isInitialized: !!org.isInitialized,
        initializedAt: org.initializedAt,
        setupStep: org.setupStep ?? 1,
        companyName: org.companyName,
        legalName: org.legalName,
        tagline: org.tagline,
        description: org.description,
        gstin: org.gstin,
        pan: org.pan,
        tan: org.tan,
        cin: org.cin,
        registrationNumber: org.registrationNumber,
        lin: org.lin,
        msmeRegistrationNumber: org.msmeRegistrationNumber,
        epfoEstablishmentCode: org.epfoEstablishmentCode,
        esicEmployerCode: org.esicEmployerCode,
        ptRegistrationNumber: org.ptRegistrationNumber,
        labourLicenseNumber: org.labourLicenseNumber,
        registeredAddress: org.registeredAddress,
        corporateAddress: org.corporateAddress,
        city: org.city,
        state: org.state,
        country: org.country || 'India',
        pincode: org.pincode,
        phone: org.phone,
        mobile: org.mobile,
        contactEmail: org.email,
        website: org.website,
        companyLogoUrl: org.companyLogoUrl,
        faviconUrl: org.faviconUrl,
        reportLogoUrl: org.reportLogoUrl,
        emailLogoUrl: org.emailLogoUrl,
        primaryColor: org.primaryColor || '#5546e0',
        secondaryColor: org.secondaryColor || '#14161d',
        assetMeta: jsonOrDefault(org.assetMeta, {}),
        signatories: jsonOrDefault(org.signatories, []),
        sealUrl: org.sealUrl,
        banking: jsonOrDefault(org.banking, {}),
        policies: jsonOrDefault(org.policies, {}),
        orgPayrollAttendancePrefs: jsonOrDefault(org.attendancePayrollPrefs, {}),
        documentNumbering: jsonOrDefault(org.documentNumbering, {}),
        customEmployeeTypes: jsonOrDefault(org.customEmployeeTypes, []),
        enableWFH: !!org.enableWFH,
        maxEmployees: org.maxEmployees ?? 999999,
      },
    });

    // --- Pass 1: Users (no departmentId/reportingManagerId/initializedById yet) ---
    console.log('Inserting users...');
    for (const u of users) {
      await prisma.user.create({
        data: {
          id: u._id,
          organizationId: REAL_ORG_ID,
          email: u.email,
          password: u.password, // bcrypt hash, same algorithm as backend-v2's bcrypt lib
          name: u.name,
          role: ROLE_MAP[u.role] || 'EMPLOYEE',
          isFounder: !!u.isFounder,
          isActive: !!u.isActive,
          mustChangePassword: !!u.mustChangePassword,
          emailVerified: !!u.emailVerified,
          lastLoginAt: u.lastLoginAt,
          employeeId: u.employeeId,
          designation: u.designation || '',
          contactNumber: u.contactNumber || '',
          joiningDate: u.joiningDate || new Date(),
          employeeType: u.employeeType || 'permanent',
          employmentStatus: EMPLOYMENT_STATUS_MAP[u.employmentStatus] || 'ONBOARDING',
          gender: u.gender ? GENDER_MAP[u.gender] : null,
          probationEndDate: u.probationEndDate,
          probationStatus: u.probationStatus ? PROBATION_STATUS_MAP[u.probationStatus] : null,
          personalData: jsonOrDefault(u.personalData, {}),
          notificationPreferences: jsonOrDefault(u.notificationPreferences, { mutedCategories: [], emailEnabled: true }),
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        },
      });
    }

    // --- Pass 1: Departments (no departmentHeadId/workLocationId yet) ---
    console.log('Inserting departments...');
    for (const d of departments) {
      await prisma.department.create({
        data: {
          id: d._id,
          organizationId: REAL_ORG_ID,
          name: d.name,
          code: d.code,
          description: d.description || '',
          isActive: !!d.isActive,
          shiftStartTime: d.shiftStartTime || '09:30',
          shiftEndTime: d.shiftEndTime || '18:30',
          lateInThresholdMinutes: d.lateInThresholdMinutes ?? 15,
          earlyOutThresholdMinutes: d.earlyOutThresholdMinutes ?? 15,
          minHoursForPresent: d.minHoursForPresent ?? 8,
          minHoursForHalfDay: d.minHoursForHalfDay ?? 4,
          weeklyOffs: jsonOrDefault(d.weeklyOffs, [0]),
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        },
      });
    }

    // --- Pass 1: WorkLocations (no createdById yet) ---
    console.log('Inserting work locations...');
    for (const w of workLocations) {
      await prisma.workLocation.create({
        data: {
          id: w._id,
          organizationId: REAL_ORG_ID,
          name: w.name,
          address: w.address || '',
          description: w.description || '',
          latitude: w.latitude,
          longitude: w.longitude,
          radiusMeters: w.radiusMeters ?? 200,
          fenceType: FENCE_TYPE_MAP[w.fenceType] || 'CIRCLE',
          boundary: jsonOrDefault(w.boundary, null),
          isActive: !!w.isActive,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
        },
      });
    }

    // --- Pass 1: SalaryComponents (no createdById yet) ---
    console.log('Inserting salary components...');
    for (const s of salaryComponents) {
      await prisma.salaryComponent.create({
        data: {
          id: s._id,
          organizationId: REAL_ORG_ID,
          name: s.name,
          code: s.code,
          type: SALARY_COMPONENT_TYPE_MAP[s.type],
          calcType: CALC_TYPE_MAP[s.calcType] || 'FIXED',
          percentageOf: s.percentageOf,
          percentageValue: s.percentageValue,
          formula: s.formula,
          defaultValue: s.defaultValue ?? 0,
          isTaxable: !!s.isTaxable,
          includeInGross: !!s.includeInGross,
          includeInNet: !!s.includeInNet,
          includeInCTC: !!s.includeInCTC,
          isEmployerContribution: !!s.isEmployerContribution,
          showOnPayslip: !!s.showOnPayslip,
          isStatutory: !!s.isStatutory,
          statutoryKey: s.statutoryKey || null,
          payFrequency: PAY_FREQUENCY_MAP[s.payFrequency] || 'MONTHLY',
          displayOrder: s.displayOrder ?? 0,
          isActive: !!s.isActive,
          isSystemDefault: !!s.isSystemDefault,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        },
      });
    }

    // --- Pass 1: LeaveTypes (no createdById yet) ---
    console.log('Inserting leave types...');
    for (const l of leaveTypes) {
      await prisma.leaveType.create({
        data: {
          id: l._id,
          organizationId: REAL_ORG_ID,
          name: l.name,
          code: l.code,
          description: l.description || '',
          color: l.color || '#3b82f6',
          isActive: !!l.isActive,
          isPaid: !!l.isPaid,
          displayOrder: l.displayOrder ?? 0,
          allocationType: ALLOCATION_TYPE_MAP[l.allocationType] || 'FIXED_ANNUAL',
          annualQuota: l.annualQuota ?? 0,
          accrualFrequency: ACCRUAL_FREQUENCY_MAP[l.accrualFrequency] || 'YEARLY',
          accrualAmountPerCycle: l.accrualAmountPerCycle ?? 0,
          prorateOnJoining: !!l.prorateOnJoining,
          applicableDepartments: jsonOrDefault(l.applicableDepartments, []),
          applicableEmployeeTypes: jsonOrDefault(l.applicableEmployeeTypes, []),
          applicableGenders: jsonOrDefault(l.applicableGenders, []),
          minServiceMonths: l.minServiceMonths ?? 0,
          maxServiceMonths: l.maxServiceMonths,
          salaryImpactPercent: l.salaryImpactPercent ?? 100,
          affectsLopCalculation: !!l.affectsLopCalculation,
          requiresApproval: !!l.requiresApproval,
          approvalLevels: l.approvalLevels ?? 2,
          autoApproveIfNoAction: !!l.autoApproveIfNoAction,
          autoApproveDays: l.autoApproveDays ?? 0,
          rules: jsonOrDefault(l.rules, {}),
          documentsRequired: !!l.documentsRequired,
          documentRequiredAfterDays: l.documentRequiredAfterDays,
          carryForward: jsonOrDefault(l.carryForward, {}),
          negativeBalance: jsonOrDefault(l.negativeBalance, {}),
          encashment: jsonOrDefault(l.encashment, {}),
          createdAt: l.createdAt,
          updatedAt: l.updatedAt,
        },
      });
    }

    // --- Pass 1: StatutoryConfigVersions (no createdById yet) ---
    console.log('Inserting statutory config versions...');
    for (const s of statutoryConfigVersions) {
      await prisma.statutoryConfigVersion.create({
        data: {
          id: s._id,
          organizationId: REAL_ORG_ID,
          module: STATUTORY_MODULE_MAP[s.module],
          effectiveFrom: toDateStr(s.effectiveFrom),
          effectiveTo: toDateStr(s.effectiveTo),
          config: jsonOrDefault(s.config, {}),
          isEnabled: !!s.isEnabled,
          notes: s.notes || '',
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        },
      });
    }

    // --- Holidays (departmentId already resolvable) ---
    console.log('Inserting holidays...');
    for (const h of holidays) {
      await prisma.holiday.create({
        data: {
          id: h._id,
          organizationId: REAL_ORG_ID,
          name: h.name,
          date: h.date,
          departmentId: h.department,
          year: h.year,
          isOptional: !!h.isOptional,
          type: HOLIDAY_TYPE_MAP[h.type] || 'COMPANY',
          state: h.state,
          description: h.description || '',
          createdAt: h.createdAt,
          updatedAt: h.updatedAt,
        },
      });
    }

    // --- EmployeeTimeline (employeeId resolvable; performedById deferred) ---
    console.log('Inserting employee timeline...');
    for (const t of employeeTimeline) {
      await prisma.employeeTimeline.create({
        data: {
          id: t._id,
          organizationId: REAL_ORG_ID,
          employeeId: t.employee,
          category: TIMELINE_CATEGORY_MAP[t.category],
          eventKey: t.eventKey,
          title: t.title,
          description: t.description || '',
          occurredAt: t.occurredAt,
          remarks: t.remarks || '',
          relatedDocument: t.relatedDocument || '',
          status: t.status || '',
          metadata: jsonOrDefault(t.metadata, {}),
          createdAt: t.createdAt,
        },
      });
    }

    // --- LeaveBalance (employeeId + leaveTypeId both resolvable) ---
    console.log('Inserting leave balances...');
    for (const b of leaveBalances) {
      await prisma.leaveBalance.create({
        data: {
          id: b._id,
          organizationId: REAL_ORG_ID,
          employeeId: b.employee,
          leaveTypeId: b.leaveType,
          year: b.year,
          opening: b.opening ?? 0,
          credited: b.credited ?? 0,
          availed: b.availed ?? 0,
          pending: b.pending ?? 0,
          encashed: b.encashed ?? 0,
          adjusted: b.adjusted ?? 0,
          carriedForwardOut: b.carriedForwardOut ?? 0,
          carriedInExpiresOn: b.carriedInExpiresOn,
          closing: b.closing ?? 0,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        },
      });
    }

    // --- PayrollSettings (updatedById deferred) ---
    console.log('Inserting payroll settings...');
    for (const p of payrollSettingsRows) {
      await prisma.payrollSettings.create({
        data: {
          id: p._id,
          organizationId: REAL_ORG_ID,
          financialYearStartMonth: p.financialYearStartMonth ?? 4,
          processingDay: p.processingDay ?? 0,
          paymentDay: p.paymentDay ?? 0,
          currency: p.currency || 'INR',
          currencySymbol: p.currencySymbol || '₹',
          roundingRule: p.roundingRule || 'nearest',
          roundingDecimals: p.roundingDecimals ?? 0,
          pfEnabled: !!p.pfEnabled,
          esiEnabled: !!p.esiEnabled,
          ptEnabled: !!p.ptEnabled,
          lwfEnabled: !!p.lwfEnabled,
          npsEnabled: !!p.npsEnabled,
          gratuityEnabled: !!p.gratuityEnabled,
          bonusEnabled: !!p.bonusEnabled,
          incomeTaxEnabled: !!p.incomeTaxEnabled,
          employerInsuranceEnabled: !!p.employerInsuranceEnabled,
          pfEmployeeRate: p.pfEmployeeRate ?? 12,
          pfEmployerRate: p.pfEmployerRate ?? 12,
          pfWageCeiling: p.pfWageCeiling ?? 15000,
          esiEmployeeRate: p.esiEmployeeRate ?? 0.75,
          esiEmployerRate: p.esiEmployerRate ?? 3.25,
          esiWageCeiling: p.esiWageCeiling ?? 21000,
          ptSlabs: jsonOrDefault(p.ptSlabs, []),
          lwfEmployeeAmount: p.lwfEmployeeAmount ?? 25,
          lwfEmployerAmount: p.lwfEmployerAmount ?? 75,
          npsEmployerRate: p.npsEmployerRate ?? 10,
          gratuityRate: p.gratuityRate ?? 4.81,
          compOffExpiryDays: p.compOffExpiryDays ?? 90,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        },
      });
    }

    // --- EmployeeSalaryComponent (employeeId + componentId resolvable; createdById deferred) ---
    console.log('Inserting employee salary components...');
    for (const e of employeeSalaryComponents) {
      await prisma.employeeSalaryComponent.create({
        data: {
          id: e._id,
          organizationId: REAL_ORG_ID,
          employeeId: e.employee,
          componentId: e.component,
          componentCode: e.componentCode,
          valueType: CALC_TYPE_MAP[e.valueType] || 'FIXED',
          fixedAmount: e.fixedAmount,
          percentageValue: e.percentageValue,
          percentageOf: e.percentageOf,
          formula: e.formula,
          amountBasis: AMOUNT_BASIS_MAP[e.amountBasis] || 'MONTHLY',
          isEnabled: !!e.isEnabled,
          effectiveFrom: toDateStr(e.effectiveFrom),
          effectiveTo: toDateStr(e.effectiveTo),
          revisionNote: e.revisionNote || '',
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        },
      });
    }

    // --- AuditLog (actorId resolvable) ---
    console.log('Inserting audit logs...');
    for (const a of auditLogs) {
      await prisma.auditLog.create({
        data: {
          id: a._id,
          organizationId: REAL_ORG_ID,
          actorId: a.actor,
          action: a.action,
          module: AUDIT_MODULE_MAP[a.module],
          targetId: a.targetId,
          details: jsonOrDefault(a.details, {}),
          ipAddress: a.ipAddress || '',
          createdAt: a.createdAt,
        },
      });
    }

    // --- Pass 2: backfill deferred FKs ---
    console.log('Backfilling cross-references...');
    for (const u of users) {
      await prisma.user.update({
        where: { id: u._id },
        data: {
          departmentId: u.department || null,
          reportingManagerId: u.reportingManager || null,
        },
      });
    }
    for (const d of departments) {
      await prisma.department.update({
        where: { id: d._id },
        data: {
          departmentHeadId: d.departmentHead || null,
          workLocationId: d.workLocation || null,
        },
      });
    }
    for (const w of workLocations) {
      if (w.createdBy) {
        await prisma.workLocation.update({ where: { id: w._id }, data: { createdById: w.createdBy } });
      }
    }
    for (const s of salaryComponents) {
      if (s.createdBy) {
        await prisma.salaryComponent.update({ where: { id: s._id }, data: { createdById: s.createdBy } });
      }
    }
    for (const l of leaveTypes) {
      if (l.createdBy) {
        await prisma.leaveType.update({ where: { id: l._id }, data: { createdById: l.createdBy } });
      }
    }
    for (const s of statutoryConfigVersions) {
      if (s.createdBy) {
        await prisma.statutoryConfigVersion.update({ where: { id: s._id }, data: { createdById: s.createdBy } });
      }
    }
    for (const t of employeeTimeline) {
      if (t.performedBy) {
        await prisma.employeeTimeline.update({ where: { id: t._id }, data: { performedById: t.performedBy } });
      }
    }
    for (const p of payrollSettingsRows) {
      if (p.updatedBy) {
        await prisma.payrollSettings.update({ where: { id: p._id }, data: { updatedById: p.updatedBy } });
      }
    }
    for (const e of employeeSalaryComponents) {
      if (e.createdBy) {
        await prisma.employeeSalaryComponent.update({ where: { id: e._id }, data: { createdById: e.createdBy } });
      }
    }
    if (org.initializedBy) {
      await prisma.organization.update({ where: { id: org._id }, data: { initializedById: org.initializedBy } });
    }

    // Keep the row-locked employeeId counter ahead of the highest migrated
    // employeeId (format "DP-000N") so the next employee created doesn't
    // collide with a migrated one.
    const maxSeq = users.reduce((max, u) => {
      const m = /^DP-(\d+)$/.exec(u.employeeId || '');
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);
    if (maxSeq > 0) {
      await prisma.organization.update({ where: { id: org._id }, data: { employeeIdCounter: maxSeq, employeeIdPrefix: 'DP' } });
    }

    console.log('Done. Migrated organization:', org.companyName, `(${org._id})`);
  } finally {
    await mysqlConn.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
