import test from 'node:test';
import assert from 'node:assert/strict';
import { googleAuthorizationUrl, verifyGoogleIdToken, pkceChallenge } from '../src/auth/google.ts';
import { randomToken, base64url } from '../src/auth/security.ts';

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name:'RSASSA-PKCS1-v1_5', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },
  true, ['sign','verify']
);
const jwk = {...await crypto.subtle.exportKey('jwk',publicKey),kid:'test-key-01',use:'sig',alg:'RS256'};
const clientId='unit-test-id.apps.googleusercontent.com';
const nonce='fixed-nonce-for-crypto-test';
const now=Math.floor(Date.now()/1000);

async function sign(claims={},header={}){
  const h=base64url(new TextEncoder().encode(JSON.stringify({alg:'RS256',kid:jwk.kid,typ:'JWT',...header})));
  const p=base64url(new TextEncoder().encode(JSON.stringify({iss:'https://accounts.google.com',aud:clientId,iat:now,exp:now+3600,sub:'test-subject-1',email:'Pastor@Example.org',email_verified:true,nonce,...claims})));
  const msg=h+'.'+p;
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',privateKey,new TextEncoder().encode(msg));
  return msg+'.'+base64url(new Uint8Array(signature));
}

test('verifies RSA signature, issuer, audience, nonce and verified email',async()=>{
  const result=await verifyGoogleIdToken(await sign(),clientId,nonce,[jwk],now);
  assert.deepEqual(result,{subject:'test-subject-1',email:'pastor@example.org',displayName:'Pastor'});
});

test('rejects tokens with invalid nonce, audience, expiry and unverified email',async()=>{
  for(const changes of [{nonce:'attacker'},{aud:'wrong-client'},{exp:now-3600},{email_verified:false},{iss:'https://evil.example.com'}]){
    await assert.rejects(verifyGoogleIdToken(await sign(changes),clientId,nonce,[jwk],now));
  }
});

test('rejects algorithm substitution and tampered signatures',async()=>{
  await assert.rejects(verifyGoogleIdToken(await sign({}, {alg:'none'}),clientId,nonce,[jwk],now));
  const signed=await sign();
  const tampered=signed.slice(0,-3)+'AAA';
  await assert.rejects(verifyGoogleIdToken(tampered,clientId,nonce,[jwk],now));
  await assert.rejects(verifyGoogleIdToken('not-a.jwt',clientId,nonce,[jwk],now));
});

test('authorization URL uses server code exchange, nonce, state and S256 PKCE',async()=>{
  const verifier=randomToken();const url=new URL(googleAuthorizationUrl(clientId,'https://sermons.example.org/auth/google/callback','state123',nonce,await pkceChallenge(verifier)));
  assert.equal(url.host,'accounts.google.com');
  assert.equal(url.searchParams.get('response_type'),'code');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal(url.searchParams.get('redirect_uri'),'https://sermons.example.org/auth/google/callback');
  assert.equal(url.searchParams.get('state'),'state123');
  assert.equal(url.searchParams.get('nonce'),nonce);
  assert.equal(url.searchParams.get('scope'),'openid email profile');
});
