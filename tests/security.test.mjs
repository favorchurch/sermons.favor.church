import test from 'node:test';
import assert from 'node:assert/strict';
import {
  can, canInvite, canManageMember, randomToken, sha256, getCookie,
  sessionCookie, clearSessionCookie, flowCookie, constantTimeEqual,
  requiresSameOrigin, publicOrigin, parseEmail
} from '../src/auth/security.ts';

test('all four roles have explicit immutable privilege boundaries', () => {
  for (const role of ['owner','admin','editor','viewer']) assert.equal(can(role,'read'),true);
  for (const role of ['owner','admin','editor']) assert.equal(can(role,'edit'),true);
  assert.equal(can('viewer','edit'),false);
  for (const action of ['manage_admin','consent','export','delete','transfer']) {
    assert.equal(can('owner',action),true);
    for(const role of ['admin','editor','viewer']) assert.equal(can(role,action),false);
  }
  assert.equal(canInvite('owner','admin'),true);
  assert.equal(canInvite('admin','editor'),true);
  assert.equal(canInvite('admin','viewer'),true);
  assert.equal(canInvite('admin','admin'),false);
  assert.equal(canInvite('editor','viewer'),false);
  assert.equal(canInvite('owner','owner'),false);
  assert.equal(canManageMember('owner','admin','revoke'),true);
  assert.equal(canManageMember('admin','admin','revoke'),false);
  assert.equal(canManageMember('admin','viewer','admin'),false);
  assert.equal(canManageMember('owner','owner','viewer'),false);
});

test('session cookie is host-only and flow cookie is secure callback-only', () => {
  const token = randomToken();
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  assert.match(sessionCookie(token),/^__Host-sb_session=/);
  for (const part of ['Path=/;','Secure;','HttpOnly;','SameSite=Lax']) assert.ok(sessionCookie(token).includes(part));
  assert.match(flowCookie('state'),/Path=\/auth\/google\/callback/);
  assert.match(clearSessionCookie(),/Max-Age=0/);
  assert.ok(!sessionCookie(token).includes('Domain='));
});

test('duplicate cookies and wrong-origin mutations are rejected', () => {
  const request = new Request('https://sermons.example.org/api/me',{headers:{cookie:'a=1; a=2'}});
  assert.equal(getCookie(request,'a'),null);
  assert.equal(getCookie(new Request('https://sermons.example.org/',{headers:{cookie:'a=1; b=2'}}),'b'),'2');
  assert.equal(requiresSameOrigin(new Request('https://sermons.example.org/api',{method:'POST',headers:{origin:'https://sermons.example.org'}}),'https://sermons.example.org'),true);
  assert.equal(requiresSameOrigin(new Request('https://sermons.example.org/api',{method:'POST',headers:{origin:'https://evil.example.org'}}),'https://sermons.example.org'),false);
  assert.equal(requiresSameOrigin(new Request('https://sermons.example.org/api',{method:'POST'}),'https://sermons.example.org'),false);
});

test('hashed tokens cannot be confused with raw secrets', async () => {
  const a = randomToken(), b = randomToken();
  assert.notEqual(a,b);
  assert.notEqual(await sha256(a),a);
  assert.notEqual(await sha256(a),await sha256(b));
  assert.equal(constantTimeEqual(a,a),true);
  assert.equal(constantTimeEqual(a,b),false);
  assert.equal(constantTimeEqual(a,a+'x'),false);
});

test('origin and email validation fail closed', () => {
  assert.equal(publicOrigin({PUBLIC_ORIGIN:'https://sermons.example.org'}),'https://sermons.example.org');
  assert.equal(publicOrigin({PUBLIC_ORIGIN:'http://sermons.example.org'}),null);
  assert.equal(publicOrigin({PUBLIC_ORIGIN:'https://sermons.example.org/path'}),null);
  assert.equal(parseEmail('  Pastor@Example.ORG  '),'pastor@example.org');
  assert.equal(parseEmail('bad@email@domain.org'),null);
});
