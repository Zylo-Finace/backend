import { WILDCARD_PERMISSION } from './permission.enum';

/** Everything needed to decide what one membership may do. */
export interface PermissionGrant {
  /** Slugs granted by the assigned role. May contain `*` or `resource:*`. */
  rolePermissions: readonly string[];
  /** One-off additions on top of the role. */
  extraPermissions?: readonly string[];
  /** One-off removals. Always win — see {@link resolveEffectivePermissions}. */
  deniedPermissions?: readonly string[];
}

/**
 * Flattens a role assignment into the set of slugs a principal actually holds.
 *
 * ## Denials win
 *
 * `denied` is applied last and beats both the role and the extras, including the
 * wildcard. The alternative — additive-only — makes "an administrator who must
 * not touch money" impossible to express without cloning the entire role, and
 * cloned roles drift the moment the original changes. A deny list is also the
 * safer default to get wrong: the failure mode is someone being unable to do
 * their job and asking, rather than silently retaining access after an incident.
 *
 * ## Wildcards
 *
 * `*` grants everything. `resource:*` grants every action on one resource. Both
 * are expanded at *check* time rather than here, because expanding them here
 * would freeze the grant against the catalogue as it existed when the role was
 * saved — a permission added in a later release would not be covered, and every
 * owner would silently lose access to new features.
 */
export interface EffectivePermissions {
  /** Literal slugs held, wildcards included verbatim. */
  readonly slugs: ReadonlySet<string>;
  /** True when the principal holds `*`. */
  readonly isSuperset: boolean;
  /** Resources with a `resource:*` grant. */
  readonly wildcardResources: ReadonlySet<string>;
  /** Slugs explicitly denied, which no grant can override. */
  readonly denied: ReadonlySet<string>;
}

export function resolveEffectivePermissions(grant: PermissionGrant): EffectivePermissions {
  const denied = new Set(grant.deniedPermissions ?? []);
  const slugs = new Set<string>();
  const wildcardResources = new Set<string>();
  let isSuperset = false;

  for (const slug of [...grant.rolePermissions, ...(grant.extraPermissions ?? [])]) {
    if (denied.has(slug)) continue;

    if (slug === WILDCARD_PERMISSION) {
      isSuperset = true;
      continue;
    }

    const [resource, action] = slug.split(':');
    if (action === '*' && resource) {
      wildcardResources.add(resource);
      continue;
    }

    slugs.add(slug);
  }

  return { slugs, isSuperset, wildcardResources, denied };
}

/** True when `permission` is satisfied by the resolved grant. */
export function grants(effective: EffectivePermissions, permission: string): boolean {
  // Checked first so a denial cannot be routed around by a wildcard.
  if (effective.denied.has(permission)) return false;
  if (effective.slugs.has(permission)) return true;
  if (effective.isSuperset) return true;

  const resource = permission.split(':')[0];
  return resource !== undefined && effective.wildcardResources.has(resource);
}

/**
 * Expands a grant into concrete slugs for transport to the UI.
 *
 * The admin panel needs a literal list to tick checkboxes and hide navigation,
 * and it must not reimplement wildcard logic — a second implementation is a
 * second place for the rules to be subtly wrong, and this one would be the copy
 * that decides what a user *sees*.
 */
export function expandPermissions(
  effective: EffectivePermissions,
  catalogue: readonly string[],
): string[] {
  return catalogue.filter((permission) => grants(effective, permission));
}
