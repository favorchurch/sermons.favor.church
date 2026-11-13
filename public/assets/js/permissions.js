// Mirrors the server rules (src/auth/security.ts `can`, `canInvite`, `canManageMember`) so the UI
// can hide controls a role cannot use. This is presentation only: every mutation is still
// checked by the server.
export function canEdit(role) {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

/** Invite and manage members. */
export const canManagePeople = role => role === 'owner' || role === 'admin';
/** Owner-only operations: consent to indexing, revoke, import review. */
export const isOwner = role => role === 'owner';

export const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
export const ROLE_ORDER = ['owner', 'admin', 'editor', 'viewer'];

/** Roles `actor` may hand out in an invitation, or to an existing member. */
export function assignableRoles(actor) {
  if (actor === 'owner') return ['admin', 'editor', 'viewer'];
  if (actor === 'admin') return ['editor', 'viewer'];
  return [];
}

/** Can `actor` change or revoke a member who currently holds `existing`? */
export function canManageMember(actor, existing) {
  if (existing === 'owner' || !canManagePeople(actor)) return false;
  return !(actor === 'admin' && existing === 'admin');
}

export const ROLE_ABILITIES = [
  ['View, search and download', ['owner', 'admin', 'editor', 'viewer']],
  ['Add and edit sermons, places and PDFs', ['owner', 'admin', 'editor']],
  ['Invite people and change roles', ['owner', 'admin']],
  ['Consent to indexing, revoke it, review imports', ['owner']]
];

/** Which Settings sections a role is shown. */
export const SECTION_ACCESS = {
  places: () => true,
  people: canManagePeople,
  import: isOwner,
  docs: () => true,
  workspace: () => true
};
export const canSeeSection = (role, key) => Boolean(SECTION_ACCESS[key]?.(role));
