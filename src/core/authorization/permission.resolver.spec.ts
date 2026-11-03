import { ALL_PERMISSIONS, Permission, SYSTEM_ROLES, isKnownPermission } from './permission.enum';
import { expandPermissions, grants, resolveEffectivePermissions } from './permission.resolver';

describe('resolveEffectivePermissions', () => {
  it('grants exactly what the role lists', () => {
    const effective = resolveEffectivePermissions({
      rolePermissions: [Permission.MembersRead, Permission.TeamsRead],
    });

    expect(grants(effective, Permission.MembersRead)).toBe(true);
    expect(grants(effective, Permission.MembersWrite)).toBe(false);
  });

  it('adds extras on top of the role', () => {
    const effective = resolveEffectivePermissions({
      rolePermissions: [Permission.MembersRead],
      extraPermissions: [Permission.WalletsAdjust],
    });

    expect(grants(effective, Permission.WalletsAdjust)).toBe(true);
  });

  it('lets a denial beat the role', () => {
    const effective = resolveEffectivePermissions({
      rolePermissions: [Permission.MembersRead, Permission.WalletsAdjust],
      deniedPermissions: [Permission.WalletsAdjust],
    });

    expect(grants(effective, Permission.MembersRead)).toBe(true);
    expect(grants(effective, Permission.WalletsAdjust)).toBe(false);
  });

  it('lets a denial beat an extra granted in the same breath', () => {
    // Otherwise "grant everything except X" depends on evaluation order.
    const effective = resolveEffectivePermissions({
      rolePermissions: [],
      extraPermissions: [Permission.WalletsAdjust],
      deniedPermissions: [Permission.WalletsAdjust],
    });

    expect(grants(effective, Permission.WalletsAdjust)).toBe(false);
  });

  it('lets a denial beat the wildcard', () => {
    // The point of the deny list: an owner who must not move money.
    const effective = resolveEffectivePermissions({
      rolePermissions: ['*'],
      deniedPermissions: [Permission.WalletsAdjust],
    });

    expect(grants(effective, Permission.WalletsAdjust)).toBe(false);
    expect(grants(effective, Permission.MembersWrite)).toBe(true);
  });

  it('treats `*` as covering a permission this build has never seen', () => {
    // Wildcards are expanded at check time precisely so that a permission added
    // in a later release is covered without touching stored roles.
    const effective = resolveEffectivePermissions({ rolePermissions: ['*'] });

    expect(grants(effective, 'feature-invented-next-quarter:read')).toBe(true);
  });

  it('expands a resource wildcard to every action on that resource only', () => {
    const effective = resolveEffectivePermissions({ rolePermissions: ['members:*'] });

    expect(grants(effective, Permission.MembersRead)).toBe(true);
    expect(grants(effective, Permission.MembersWrite)).toBe(true);
    expect(grants(effective, Permission.MembersRemove)).toBe(true);
    expect(grants(effective, Permission.TeamsRead)).toBe(false);
  });

  it('does not let a resource wildcard leak across a shared prefix', () => {
    const effective = resolveEffectivePermissions({ rolePermissions: ['team:*'] });

    // "team:*" must not satisfy "teams:read".
    expect(grants(effective, Permission.TeamsRead)).toBe(false);
  });

  it('grants nothing for an empty role', () => {
    const effective = resolveEffectivePermissions({ rolePermissions: [] });

    expect(expandPermissions(effective, ALL_PERMISSIONS)).toEqual([]);
  });
});

describe('expandPermissions', () => {
  it('resolves the wildcard to the full catalogue for the UI', () => {
    const effective = resolveEffectivePermissions({ rolePermissions: ['*'] });

    expect(expandPermissions(effective, ALL_PERMISSIONS)).toEqual([...ALL_PERMISSIONS]);
  });

  it('omits denied slugs so the UI hides what the guard would refuse', () => {
    const effective = resolveEffectivePermissions({
      rolePermissions: ['*'],
      deniedPermissions: [Permission.AuditRead],
    });

    expect(expandPermissions(effective, ALL_PERMISSIONS)).not.toContain(Permission.AuditRead);
  });
});

describe('the permission catalogue', () => {
  it('has no duplicate slugs', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('uses resource:action throughout', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('recognises its own slugs and rejects a typo', () => {
    expect(isKnownPermission(Permission.MembersRead)).toBe(true);
    expect(isKnownPermission('members:writ')).toBe(false);
  });

  it('seeds system roles that reference only real permissions', () => {
    for (const role of SYSTEM_ROLES) {
      for (const slug of role.permissions) {
        if (slug === '*') continue;
        expect(isKnownPermission(slug)).toBe(true);
      }
    }
  });

  it('seeds exactly one default role, or new members land nowhere', () => {
    expect(SYSTEM_ROLES.filter((role) => role.isDefault)).toHaveLength(1);
  });

  it('gives the agent role no access to access control or money', () => {
    const agent = SYSTEM_ROLES.find((role) => role.key === 'agent');
    const effective = resolveEffectivePermissions({ rolePermissions: agent?.permissions ?? [] });

    expect(grants(effective, Permission.RolesWrite)).toBe(false);
    expect(grants(effective, Permission.MembersWrite)).toBe(false);
    expect(grants(effective, Permission.WalletsAdjust)).toBe(false);
    expect(grants(effective, Permission.ApiKeysWrite)).toBe(false);
    expect(grants(effective, Permission.MessagesSend)).toBe(true);
  });
});
