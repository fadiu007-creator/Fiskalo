const POS_ADMIN_ROLES = new Set(["owner", "administrator"]);

/** Only business owners and administrators may issue or replace an ATK POS certificate. */
export function canManageAtkPos(role: unknown): boolean {
  return typeof role === "string" && POS_ADMIN_ROLES.has(role);
}
