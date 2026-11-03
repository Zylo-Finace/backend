/**
 * The permission catalogue.
 *
 * Permissions are a **compile-time constant, not database rows**. They change
 * only when code changes — a new permission is meaningless until a route
 * requires it — and a static catalogue lets TypeScript reject a typo in
 * `@RequirePermissions('members:writ')` at build time instead of silently
 * granting nothing at runtime. The database stores only *which slugs a role
 * grants*, which is genuinely tenant data.
 *
 * Slug convention: `resource:action`. Resources are plural, actions are verbs.
 * Read is always separable from write, because "can look at the audit log" and
 * "can change who has access" are different jobs in every organisation.
 *
 * Adding a permission is backwards-compatible. **Renaming one is not** — the
 * slug is persisted in `roles.permissions`, `memberships.extra_permissions` and
 * `api_keys.permissions`, so a rename silently revokes access for everyone who
 * had it. Treat this list as append-only, exactly like {@link ErrorCode}.
 */
export const Permission = {
  // -- Workspace --------------------------------------------------------------
  WorkspaceRead: 'workspace:read',
  WorkspaceWrite: 'workspace:write',

  // -- Members and access -----------------------------------------------------
  MembersRead: 'members:read',
  MembersWrite: 'members:write',
  MembersRemove: 'members:remove',

  RolesRead: 'roles:read',
  RolesWrite: 'roles:write',
  RolesDelete: 'roles:delete',

  TeamsRead: 'teams:read',
  TeamsWrite: 'teams:write',
  TeamsDelete: 'teams:delete',

  InvitationsRead: 'invitations:read',
  InvitationsWrite: 'invitations:write',
  InvitationsRevoke: 'invitations:revoke',

  SessionsRead: 'sessions:read',
  SessionsRevoke: 'sessions:revoke',

  ApiKeysRead: 'apikeys:read',
  ApiKeysWrite: 'apikeys:write',
  ApiKeysRevoke: 'apikeys:revoke',

  // -- Customers and money ----------------------------------------------------
  CustomersRead: 'customers:read',
  CustomersWrite: 'customers:write',
  CustomersSuspend: 'customers:suspend',

  WalletsRead: 'wallets:read',
  WalletsAdjust: 'wallets:adjust',

  // -- Messaging --------------------------------------------------------------
  NumbersRead: 'numbers:read',
  NumbersWrite: 'numbers:write',

  TemplatesRead: 'templates:read',
  TemplatesSync: 'templates:sync',

  ConversationsRead: 'conversations:read',
  ConversationsWrite: 'conversations:write',
  MessagesSend: 'messages:send',

  // -- Platform ---------------------------------------------------------------
  WebhooksRead: 'webhooks:read',
  WebhooksReplay: 'webhooks:replay',
  AuditRead: 'audit:read',
  AnalyticsRead: 'analytics:read',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/** Grants every permission, including ones added after the role was created. */
export const WILDCARD_PERMISSION = '*';

export const ALL_PERMISSIONS: readonly Permission[] = Object.freeze(Object.values(Permission));

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

/** True when `slug` is a permission this build knows about. */
export function isKnownPermission(slug: string): slug is Permission {
  return PERMISSION_SET.has(slug);
}

/**
 * Catalogue grouped for the admin UI's role editor.
 *
 * Lives here rather than in the frontend so a permission added to the enum
 * cannot be invisible in the picker — the endpoint that serves this is generated
 * from the same constant the guard enforces.
 */
export interface PermissionGroup {
  key: string;
  label: string;
  description: string;
  permissions: readonly Permission[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = Object.freeze([
  {
    key: 'workspace',
    label: 'Workspace',
    description: 'Business profile, branding and settings.',
    permissions: [Permission.WorkspaceRead, Permission.WorkspaceWrite],
  },
  {
    key: 'members',
    label: 'Members',
    description: 'Who has access to this workspace and what they may do.',
    permissions: [
      Permission.MembersRead,
      Permission.MembersWrite,
      Permission.MembersRemove,
      Permission.InvitationsRead,
      Permission.InvitationsWrite,
      Permission.InvitationsRevoke,
      Permission.SessionsRead,
      Permission.SessionsRevoke,
    ],
  },
  {
    key: 'access',
    label: 'Roles and teams',
    description: 'Permission bundles and routing groups.',
    permissions: [
      Permission.RolesRead,
      Permission.RolesWrite,
      Permission.RolesDelete,
      Permission.TeamsRead,
      Permission.TeamsWrite,
      Permission.TeamsDelete,
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    description: 'End users reached over WhatsApp, and their wallets.',
    permissions: [
      Permission.CustomersRead,
      Permission.CustomersWrite,
      Permission.CustomersSuspend,
      Permission.WalletsRead,
      Permission.WalletsAdjust,
    ],
  },
  {
    key: 'messaging',
    label: 'Messaging',
    description: 'WhatsApp numbers, templates and conversations.',
    permissions: [
      Permission.NumbersRead,
      Permission.NumbersWrite,
      Permission.TemplatesRead,
      Permission.TemplatesSync,
      Permission.ConversationsRead,
      Permission.ConversationsWrite,
      Permission.MessagesSend,
    ],
  },
  {
    key: 'platform',
    label: 'Platform',
    description: 'Integrations, audit trail and reporting.',
    permissions: [
      Permission.ApiKeysRead,
      Permission.ApiKeysWrite,
      Permission.ApiKeysRevoke,
      Permission.WebhooksRead,
      Permission.WebhooksReplay,
      Permission.AuditRead,
      Permission.AnalyticsRead,
    ],
  },
]);

/**
 * The roles seeded into every new workspace.
 *
 * `owner` holds the wildcard so that adding a permission never leaves an
 * existing workspace with nobody able to grant it — the bootstrapping problem
 * that makes "grant each permission explicitly" unworkable at upgrade time.
 */
export interface SystemRoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: readonly string[];
  isDefault: boolean;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = Object.freeze([
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control, including billing and workspace deletion.',
    permissions: [WILDCARD_PERMISSION],
    isDefault: false,
  },
  {
    key: 'admin',
    name: 'Administrator',
    description: 'Everything except transferring ownership.',
    permissions: ALL_PERMISSIONS,
    isDefault: false,
  },
  {
    key: 'agent',
    name: 'Agent',
    description: 'Handles conversations. No access to access control or money.',
    permissions: [
      Permission.WorkspaceRead,
      Permission.ConversationsRead,
      Permission.ConversationsWrite,
      Permission.MessagesSend,
      Permission.TemplatesRead,
      Permission.NumbersRead,
      Permission.CustomersRead,
      Permission.TeamsRead,
      Permission.MembersRead,
    ],
    isDefault: true,
  },
  {
    key: 'analyst',
    name: 'Analyst',
    description: 'Read-only across the workspace, including reporting.',
    permissions: [
      Permission.WorkspaceRead,
      Permission.AnalyticsRead,
      Permission.AuditRead,
      Permission.ConversationsRead,
      Permission.CustomersRead,
      Permission.WalletsRead,
      Permission.TemplatesRead,
      Permission.NumbersRead,
      Permission.MembersRead,
      Permission.TeamsRead,
      Permission.RolesRead,
    ],
    isDefault: false,
  },
]);
