// Purpose: What each Control Panel role may do, as the `<resource>:<action>` strings the panel's own checks read
//   (hasPermission in the panel: OWNER holds everything, otherwise an exact string or a `<resource>:*` wildcard).
// Important: pure and fixed in code for now. Editing a role's permissions from the panel's RBAC screen is a later step.
export type SuperAdminRoleName = 'OWNER' | 'ADMIN' | 'SUPPORT' | 'BILLING' | 'READ_ONLY';

export const CC_RESOURCES = [
  'super-admins',
  'rbac',
  'organizations',
  'plans',
  'subscriptions',
  'billing',
  'payments',
  'coupons',
  'feature-flags',
  'tickets',
  'announcements',
  'settings',
  'usage',
  'audit-log',
] as const;

const ADMIN_PERMISSIONS = [
  'organizations:*',
  'plans:*',
  'subscriptions:*',
  'billing:*',
  'payments:*',
  'coupons:*',
  'feature-flags:*',
  'tickets:*',
  'announcements:*',
  'settings:read',
  'usage:read',
  'audit-log:read',
  'super-admins:read',
  'rbac:read',
];

export const ROLE_PERMISSIONS: Record<SuperAdminRoleName, string[]> = {
  OWNER: ['*'],
  ADMIN: ADMIN_PERMISSIONS,
  SUPPORT: ['organizations:read', 'tickets:*', 'announcements:read', 'usage:read', 'audit-log:read'],
  BILLING: ['organizations:read', 'plans:read', 'subscriptions:*', 'billing:*', 'payments:*', 'coupons:*', 'usage:read'],
  READ_ONLY: CC_RESOURCES.filter((r) => r !== 'super-admins' && r !== 'rbac').map((r) => `${r}:read`),
};

export const permissionsFor = (role: SuperAdminRoleName): string[] => [...ROLE_PERMISSIONS[role]];

/** The same rule the panel applies: exact string, `<resource>:*`, or `*`. */
export function roleHas(role: SuperAdminRoleName, permission: string): boolean {
  const list = ROLE_PERMISSIONS[role];
  if (role === 'OWNER' || list.includes('*') || list.includes(permission)) return true;
  return list.includes(`${permission.split(':')[0]}:*`);
}
