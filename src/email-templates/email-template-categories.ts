// The fixed set of categories an EmailTemplate.category column may hold —
// used to group the Email Templates table (see frontend EmailTemplates.tsx,
// which sorts/groups by this exact list and order). Built-in occasions are
// assigned one of these at seed time (email-template-defaults.ts); a custom
// template picks one on create (defaulting to 'General') and can change it
// on edit, same as any other field.
export const EMAIL_TEMPLATE_CATEGORIES = [
  'General',
  'Attendance',
  'Leave & Comp-Off',
  'Payroll & Finance',
  'Exit',
  'Documents',
  'Account & Access',
] as const;

export type EmailTemplateCategory = (typeof EMAIL_TEMPLATE_CATEGORIES)[number];
