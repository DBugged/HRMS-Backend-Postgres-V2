import {
  offerLetterContent,
  appointmentLetterContent,
  relievingLetterContent,
  experienceLetterContent,
  experienceCertificateContent,
  salaryCertificateContent,
  fullFinalSettlementContent,
  type LetterEmployeeInfo,
} from './letter-content';

const employee: LetterEmployeeInfo = {
  name: 'Jane Doe',
  employeeId: 'DP-00042',
  designation: 'Senior Engineer',
  departmentName: 'Engineering',
  employeeType: 'permanent',
  joiningDate: new Date(2024, 0, 15),
};

describe('offerLetterContent', () => {
  it('greets the employee by name and states designation/department/joining date', () => {
    const { title, paragraphs } = offerLetterContent(employee, 'Acme Corp');
    expect(title).toBe('Offer of Employment');
    expect(paragraphs[0]).toContain('Jane Doe');
    expect(paragraphs.join(' ')).toContain('Senior Engineer');
    expect(paragraphs.join(' ')).toContain('Engineering');
    expect(paragraphs.join(' ')).toContain('15-01-2024');
    expect(paragraphs.join(' ')).toContain('Acme Corp');
  });

  it('falls back to an em dash for a missing designation/department', () => {
    const blank: LetterEmployeeInfo = {
      ...employee,
      designation: '',
      departmentName: null,
    };
    const { paragraphs } = offerLetterContent(blank, 'Acme Corp');
    expect(paragraphs.join(' ')).toContain('—');
  });
});

describe('appointmentLetterContent', () => {
  it('confirms appointment effective from the joining date', () => {
    const { title, paragraphs } = appointmentLetterContent(
      employee,
      'Acme Corp',
    );
    expect(title).toBe('Letter of Appointment');
    expect(paragraphs.join(' ')).toContain('effective 15-01-2024');
  });
});

describe('relievingLetterContent', () => {
  it('states the last working day', () => {
    const { title, paragraphs } = relievingLetterContent(
      employee,
      'Acme Corp',
      '2026-06-30',
    );
    expect(title).toBe('Relieving Letter');
    expect(paragraphs.join(' ')).toContain('30-06-2026');
  });
});

describe('experienceLetterContent', () => {
  it('states the full tenure period', () => {
    const { title, paragraphs } = experienceLetterContent(
      employee,
      'Acme Corp',
      '2026-06-30',
    );
    expect(title).toBe('Experience Letter');
    expect(paragraphs.join(' ')).toContain('15-01-2024');
    expect(paragraphs.join(' ')).toContain('30-06-2026');
  });
});

describe('experienceCertificateContent', () => {
  it('is a shorter, certificate-style statement of tenure', () => {
    const { title, paragraphs } = experienceCertificateContent(
      employee,
      'Acme Corp',
      '2026-06-30',
    );
    expect(title).toBe('Certificate of Experience');
    expect(paragraphs.length).toBeLessThanOrEqual(2);
  });
});

describe('salaryCertificateContent', () => {
  it('formats gross/net/annualized CTC with the given currency symbol', () => {
    const { title, paragraphs } = salaryCertificateContent(
      employee,
      'Acme Corp',
      {
        month: 6,
        year: 2026,
        grossSalary: 100000,
        netPay: 90000,
        ctcMonthly: 120000,
      },
      '₹',
    );
    expect(title).toBe('Salary Certificate');
    const text = paragraphs.join(' ');
    expect(text).toContain('₹1,00,000');
    expect(text).toContain('₹90,000');
    expect(text).toContain('₹14,40,000'); // 120000 * 12
    expect(text).toContain('June 2026');
  });
});

describe('fullFinalSettlementContent', () => {
  it('itemizes the settlement breakdown and states the net payable amount in words', () => {
    const { title, paragraphs } = fullFinalSettlementContent(
      employee,
      'Acme Corp',
      {
        lastWorkingDay: '2026-06-30',
        pendingSalaryAmount: 50000,
        leaveEncashmentAmount: 10000,
        bonusAmount: 5000,
        gratuityAmount: 20000,
        recoveriesAmount: 1000,
        loanBalanceRecovered: 2000,
        noticePeriodRecovery: 0,
        netSettlementAmount: 82000,
      },
      '₹',
    );
    expect(title).toBe('Full & Final Settlement Statement');
    const text = paragraphs.join(' ');
    expect(text).toContain('₹50,000');
    expect(text).toContain('Net Amount Payable: ₹82,000');
    expect(text.toLowerCase()).toContain('rupees');
  });
});
