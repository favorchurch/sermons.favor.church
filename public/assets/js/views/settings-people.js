// People & Access: members with role change and revoke, and invitations with a one-time token.
// The token is shown once in a dialog and kept nowhere else: not in state, the address or the page.
import { h, field, openDialog } from '../dom.js';
import { ROLE_LABELS, ROLE_ORDER, assignableRoles, canManageMember } from '../permissions.js';
import { actions, confirmDialog, formErrorBox, wireForm } from './dialogs.js';
import { panel, sectionBox } from './panel.js';

const roleOptions = (roles, selected) => roles.map(role => h('option', { value: role, selected: role === selected }, ROLE_LABELS[role]));

/** Dialog that shows a freshly created invitation token. Closing it discards the token. */
function tokenDialog({ invitation, toast }) {
  const input = h('input', { id: 'invite-token', type: 'text', readonly: true, value: invitation.token, 'aria-label': 'One-time invitation code', class: 'token-input', autocomplete: 'off', spellcheck: 'false' });
  const days = Math.round((invitation.expires_in_seconds || 0) / 86400);
  const copy = h('button', {
    type: 'button', class: 'btn', 'data-action': 'copy',
    onclick: async () => {
      try { await navigator.clipboard.writeText(invitation.token); toast('Code copied.'); }
      catch { input.focus?.(); input.select?.(); toast('Select the code and copy it.'); }
    }
  }, 'Copy code');
  const done = h('button', { type: 'button', class: 'btn btn-primary', 'data-autofocus': true, onclick: () => opened.close() }, 'Done');
  const body = h('div', { class: 'token-box' },
    h('p', null, `Invitation for ${invitation.email} as ${ROLE_LABELS[invitation.role] || invitation.role}.`),
    h('p', { class: 'notice', role: 'status' }, 'This code is shown only once and no email is sent. Give it to them privately. They sign in with Google using exactly this email address, then enter the code.'),
    h('div', { class: 'field' }, h('label', { for: 'invite-token' }, 'One-time code'), input),
    h('p', { class: 'hint' }, `It expires in ${days || 7} days and works once.`),
    h('div', { class: 'dialog-actions' }, copy, done));
  const opened = openDialog({ title: 'Invitation created', body });
  return opened;
}

function inviteDialog({ client, role, toast, onDone }) {
  const email = field({ label: 'Email address', name: 'email', type: 'email', required: true, maxlength: 254, autofocus: true, hint: 'The Google account they will sign in with.' });
  const roles = assignableRoles(role);
  const roleField = field({ label: 'Role', name: 'role', required: true, children: roleOptions(roles, roles.includes('viewer') ? 'viewer' : roles[0]) });
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Create invitation');
  const form = h('form', { novalidate: true }, email.wrapper, roleField.wrapper, formError, node);
  const opened = openDialog({ title: 'Invite someone', body: form });
  dialogApi.close = opened.close;
  let invitation = null;
  wireForm({
    form, submit, formError, dialog: opened, fields: { email, role: roleField },
    save: async () => { invitation = await client.invite(email.control.value, roleField.control.value); },
    onDone: () => { tokenDialog({ invitation, toast }); invitation = null; return onDone(); }
  });
  return opened;
}

function roleDialog({ client, member, actor, onDone }) {
  const roles = assignableRoles(actor);
  const roleField = field({ label: `Role for ${member.display_name}`, name: 'role', required: true, autofocus: true, children: roleOptions(roles, member.role) });
  const formError = formErrorBox();
  const dialogApi = { close: () => {} };
  const { submit, node } = actions(dialogApi, 'Save role');
  const form = h('form', { novalidate: true }, roleField.wrapper, formError, node);
  const opened = openDialog({ title: 'Change role', body: form });
  dialogApi.close = opened.close;
  wireForm({ form, submit, formError, dialog: opened, onDone, fields: { role: roleField }, save: () => client.changeRole(member.account_id, roleField.control.value) });
  return opened;
}

const revokeDialog = ({ client, member, onDone }) => confirmDialog({
  title: 'Revoke access?',
  body: `${member.display_name} (${member.email}) will lose access to this archive on their next request. Their other archives are not affected. You can invite them again later.`,
  confirmLabel: 'Revoke access', danger: true, onDone, save: () => client.revokeMember(member.account_id)
});

function memberRow(member, ctx, reload) {
  const self = member.account_id === ctx.state.account?.id;
  const manage = !self && canManageMember(ctx.state.role, member.role);
  const done = message => async () => { ctx.toast(message); await reload({ quiet: true }); };
  return h('tr', null,
    h('th', { scope: 'row', 'data-label': 'Name' }, member.display_name, self ? h('span', { class: 'pill' }, 'You') : null),
    h('td', { 'data-label': 'Email' }, member.email),
    h('td', { 'data-label': 'Role' }, ROLE_LABELS[member.role] || member.role),
    h('td', { 'data-label': 'Actions' }, manage ? h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn', 'data-action': 'role', onclick: () => roleDialog({ client: ctx.client, member, actor: ctx.state.role, onDone: done('Role changed.') }) }, 'Change role'),
      h('button', { type: 'button', class: 'btn', 'data-action': 'revoke', onclick: () => revokeDialog({ client: ctx.client, member, onDone: done('Access revoked.') }) }, 'Revoke')) : null));
}

export function peopleSection(ctx) {
  const { node, reload } = panel({
    label: 'members',
    load: async () => (await ctx.client.listMembers()).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.display_name.localeCompare(b.display_name)),
    render: members => h('div', { class: 'table-wrap' },
      h('table', { class: 'sermon-table people-table' },
        h('caption', { class: 'sr-only' }, 'Members of this archive'),
        h('thead', null, h('tr', null, ...['Name', 'Email', 'Role', 'Actions'].map(label => h('th', { scope: 'col' }, label)))),
        h('tbody', null, ...members.map(member => memberRow(member, ctx, reload)))))
  });
  const invite = h('button', {
    type: 'button', class: 'btn btn-primary', 'data-action': 'invite',
    onclick: () => inviteDialog({ client: ctx.client, role: ctx.state.role, toast: ctx.toast, onDone: () => reload({ quiet: true }) })
  }, 'Invite someone');
  return sectionBox('people-title', 'People & Access',
    'Who can open this archive. Invitations that have not been accepted yet are not listed here.',
    h('div', { class: 'section-actions' }, invite), node);
}
