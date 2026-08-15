-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "assetMeta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "banking" JSONB NOT NULL DEFAULT '{"bankName":"","accountName":"","accountNumber":"","ifscCode":"","branchName":""}',
ADD COLUMN     "cin" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "companyLogoUrl" TEXT,
ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "corporateAddress" TEXT,
ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'India',
ADD COLUMN     "customEmployeeTypes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "documentNumbering" JSONB NOT NULL DEFAULT '{"employeeId":{"label":"Employee ID","format":"DP-{0000}","resetRule":"never","counter":0,"lastPeriodKey":null},"payslip":{"label":"Payslip","format":"PS-{YYYYMM}-{0001}","resetRule":"monthly","counter":0,"lastPeriodKey":null},"offerLetter":{"label":"Offer Letter","format":"OL-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null},"appointmentLetter":{"label":"Appointment Letter","format":"AL-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null},"experienceLetter":{"label":"Experience Letter","format":"EL-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null},"relievingLetter":{"label":"Relieving Letter","format":"RL-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null},"salaryCertificate":{"label":"Salary Certificate","format":"SC-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null},"fullFinalSettlement":{"label":"Full & Final Settlement","format":"FNF-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null},"experienceCertificate":{"label":"Experience Certificate","format":"EC-{YYYY}-{0001}","resetRule":"yearly","counter":0,"lastPeriodKey":null}}',
ADD COLUMN     "emailLogoUrl" TEXT,
ADD COLUMN     "epfoEstablishmentCode" TEXT,
ADD COLUMN     "esicEmployerCode" TEXT,
ADD COLUMN     "faviconUrl" TEXT,
ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "initializedAt" TIMESTAMP(3),
ADD COLUMN     "initializedById" TEXT,
ADD COLUMN     "isInitialized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "labourLicenseNumber" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "lin" TEXT,
ADD COLUMN     "maxEmployees" INTEGER NOT NULL DEFAULT 999999,
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "msmeRegistrationNumber" TEXT,
ADD COLUMN     "orgPayrollAttendancePrefs" JSONB NOT NULL DEFAULT '{"attendanceMethod":["manual"],"defaultShiftStartTime":"09:30","defaultShiftEndTime":"18:30","defaultLateInThresholdMinutes":15,"defaultEarlyOutThresholdMinutes":15,"defaultMinHoursForPresent":8,"defaultMinHoursForHalfDay":4,"defaultWorkWeek":"monday-friday","weekendDays":[0,6],"defaultWorkingHoursPerDay":8,"enableAttendanceImport":true,"enableAttendanceRegularization":true,"enableOvertime":false,"enableCompOff":true,"payrollCycle":"monthly","salaryPaymentDay":1,"payrollFreezeDay":25,"enableLeaveEncashment":true,"enableTaxRegimeSelection":true,"defaultTaxRegime":"new","defaultLeavePolicy":"","enableHalfDayLeave":true,"enableSandwichLeave":false,"enableNegativeLeaveBalance":false,"carryForwardLeave":true,"maxCarryForwardLimit":15}',
ADD COLUMN     "pan" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "pincode" TEXT,
ADD COLUMN     "policies" JSONB NOT NULL DEFAULT '{"financialYearStartMonth":4,"leaveYearStartMonth":1,"workingHoursStart":"09:00","workingHoursEnd":"18:00","timezone":"Asia/Kolkata","currency":"INR","currencySymbol":"₹","dateFormat":"DD-MM-YYYY","timeFormat":"24","language":"English","defaultProbationDays":90,"defaultNoticeDays":30,"defaultRetirementAge":58}',
ADD COLUMN     "primaryColor" TEXT NOT NULL DEFAULT '#5546e0',
ADD COLUMN     "ptRegistrationNumber" TEXT,
ADD COLUMN     "registeredAddress" TEXT,
ADD COLUMN     "registrationNumber" TEXT,
ADD COLUMN     "reportLogoUrl" TEXT,
ADD COLUMN     "sealUrl" TEXT,
ADD COLUMN     "secondaryColor" TEXT NOT NULL DEFAULT '#14161d',
ADD COLUMN     "setupStep" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "signatories" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "state" TEXT,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "tan" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "resetPasswordExpires" TIMESTAMP(3),
ADD COLUMN     "resetPasswordToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_resetPasswordToken_key" ON "users"("resetPasswordToken");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_initializedById_fkey" FOREIGN KEY ("initializedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
