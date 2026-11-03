# Backup and restore

## What to back up
- **PostgreSQL database** (all HR, payroll and audit data) - daily full backup, kept 30 days; weekly copy kept 12 months.
- **Uploaded files** (documents, payslips, selfies, cheques): the S3 bucket - turn on bucket versioning and cross-region replication.
- **Secrets** (`.env`, `JWT_*`, `FILE_TOKEN_SECRET`, SMTP): keep in the password manager, never in the repo.

## Daily backup
    pg_dump "$DATABASE_URL" --format=custom --no-owner --file="hrms-$(date +%F).dump"
Copy the dump off the server (S3 bucket with a lifecycle rule). Run it from cron at a quiet hour and alert if it did not run.

## Restore (test this every quarter on a spare database)
    createdb hrms_restore
    pg_restore --no-owner --dbname=hrms_restore hrms-YYYY-MM-DD.dump
    DATABASE_URL=postgresql://.../hrms_restore npx prisma migrate status
Point a staging backend at it, sign in, open an employee and a payslip. Only then repeat against production, in a maintenance window.

## Uptime and errors
- Uptime monitor: `GET /health` every minute. 200 = server and database are up; 503 = database down.
- Errors: set `SENTRY_DSN` on the backend. The web app and mobile app report crashes to the backend (`POST /client-errors`).
