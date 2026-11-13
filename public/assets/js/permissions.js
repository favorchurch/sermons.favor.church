// Mirrors the server rule (src/auth/security.ts `can`) so the UI can hide controls a role
// cannot use. This is presentation only: every mutation is still checked by the server.
export function canEdit(role) {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

export const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
