// Default occasion-based email templates seeded for every new org, mirroring
// the content HrEventsService used to hardcode inline (see the git history of
// sendBirthdayWish/sendAnniversaryWish before this module existed). Content
// is equivalent, not verbatim — the hardcoded strings had no company
// signature block at all, so one is added here using the
// {{companyName}}/{{companyPhone}}/{{companyWebsite}}/{{companyEmail}}/
// {{companyAddress}} placeholders EmailTemplatesService.render() supports.
export interface EmailTemplateDefault {
  occasionKey: string;
  name: string;
  subject: string;
  bodyHtml: string;
  ccAllActive: boolean;
}

export const EMAIL_TEMPLATE_DEFAULTS: EmailTemplateDefault[] = [
  {
    occasionKey: 'BIRTHDAY',
    name: 'Birthday Wish',
    subject: 'Happy Birthday!',
    bodyHtml:
      '<p>Happy Birthday, {{employeeName}}! Wishing you a wonderful year ahead, from everyone here.</p>' +
      '<p>Warm regards,<br/>{{companyName}}</p>' +
      '<p style="color:#888;font-size:12px;">{{companyName}} | {{companyAddress}} | {{companyPhone}} | {{companyEmail}} | {{companyWebsite}}</p>',
    ccAllActive: true,
  },
  {
    occasionKey: 'WORK_ANNIVERSARY',
    name: 'Work Anniversary Wish',
    subject: 'Happy Work Anniversary!',
    bodyHtml:
      "<p>Congratulations on your {{years}} work anniversary, {{employeeName}}! Thank you for everything you've contributed.</p>" +
      '<p>Warm regards,<br/>{{companyName}}</p>' +
      '<p style="color:#888;font-size:12px;">{{companyName}} | {{companyAddress}} | {{companyPhone}} | {{companyEmail}} | {{companyWebsite}}</p>',
    ccAllActive: true,
  },
];
