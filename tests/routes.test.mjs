import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleRequest } from '../src/auth/app.ts';
import { sha256, randomToken, SESSION_COOKIE } from '../src/auth/security.ts';

const origin='https://sermons.example.org';
const ids={owner:'a0000000-0000-4000-8000-000000000001',admin:'a0000000-0000-4000-8000-000000000002',viewer:'a0000000-0000-4000-8000-000000000003',invitee:'a0000000-0000-4000-8000-000000000004',
  w1:'b0000000-0000-4000-8000-000000000001',w2:'b0000000-0000-4000-8000-000000000002',sermon1:'c0000000-0000-4000-8000-000000000001',sermon2:'c0000000-0000-4000-8000-000000000002'};
class DatabaseMock {
  constructor(){
    this.connection=new DatabaseSync(':memory:');
    this.connection.exec('PRAGMA foreign_keys=ON');
    for(const file of ['0001_initial.sql','0002_auth.sql'])this.connection.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  }
  prepare(sql){const db=this.connection;
    return {bind(...args){
      return {
        async first(){return db.prepare(sql).get(...args)??null},
        async all(){return {results:db.prepare(sql).all(...args)}},
        async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}
      };
    }};
  }
  async batch(statements){this.connection.exec('BEGIN');try{const responses=[];for(const s of statements)responses.push(await s.run());this.connection.exec('COMMIT');return responses}catch(e){this.connection.exec('ROLLBACK');throw e}}
  execute(sql,args=[]){return this.connection.prepare(sql).run(...args)}
  close(){this.connection.close()}
}
async function fixture(){
  const db=new DatabaseMock();
  const accounts=[[ids.owner,'owner@example.test'],[ids.admin,'admin@example.test'],[ids.viewer,'viewer@example.test'],[ids.invitee,'invitee@example.test']];
  for(const [id,email] of accounts)db.execute('INSERT INTO user_accounts(id,email_normalized,display_name) VALUES (?,?,?)',[id,email,id]);
  for(const [w,owner,name] of [[ids.w1,ids.owner,'Private Alpha'],[ids.w2,ids.invitee,'Private Beta']])db.execute('INSERT INTO workspaces(id,name,owner_account_id) VALUES (?,?,?)',[w,name,owner]);
  for(const [w,id,role] of [[ids.w1,ids.owner,'owner'],[ids.w1,ids.admin,'admin'],[ids.w1,ids.viewer,'viewer'],[ids.w2,ids.invitee,'owner']])db.execute('INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES(?,?,?,CURRENT_TIMESTAMP)',[w,id,role]);
  db.execute('INSERT INTO sermons(id,workspace_id,title) VALUES(?,?,?)',[ids.sermon1,ids.w1,'Alpha is private']);
  db.execute('INSERT INTO sermons(id,workspace_id,title) VALUES(?,?,?)',[ids.sermon2,ids.w2,'Beta secret']);
  const env={DB:db,PUBLIC_ORIGIN:origin,GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fake-unit-secret',PILOT_OWNER_EMAILS:'owner@example.test'};
  const tokens={};
  for(const [id,email] of accounts){const token=randomToken();tokens[id]=token;db.execute('INSERT INTO auth_sessions(token_hash,account_id,expires_at) VALUES(?,?,?)',[await sha256(token),id,Math.floor(Date.now()/1000)+86400]);}
  const request=(method,path,actor,body,extra={})=>new Request(origin+path,{method,headers:{...(actor?{cookie:SESSION_COOKIE+'='+tokens[actor]}:{}),...(method==='GET'?{}:{origin,'content-type':'application/json'}),...extra},body:method==='GET'?undefined:(body===undefined?undefined:JSON.stringify(body))});
  return {env,tokens,request,db};
}

test('no session or nonexistent workspace returns no protected content',async()=>{
 const f=await fixture();try{
  const anonymous=await handleRequest(new Request(origin+'/api/workspaces/'+ids.w1+'/sermons'),f.env);
  assert.equal(anonymous.status,401); assert.ok(!(await anonymous.text()).includes('Alpha'));
  const cross=await handleRequest(f.request('GET','/api/workspaces/'+ids.w2+'/sermons',ids.viewer),f.env);
  assert.equal(cross.status,404);assert.ok(!(await cross.text()).includes('Beta'));
  const mine=await handleRequest(f.request('GET','/api/workspaces/'+ids.w1+'/sermons',ids.viewer),f.env);
  assert.equal(mine.status,200);const data=await mine.json();assert.equal(data.sermons.length,1);assert.equal(data.sermons[0].title,'Alpha is private');assert.ok(!JSON.stringify(data).includes('Beta secret'));
  assert.equal(mine.headers.get('cache-control'),'no-store, private');
 }finally{f.db.close()}
});

test('workspace list returns only accepted active memberships',async()=>{
 const f=await fixture();try{
   const response=await handleRequest(f.request('GET','/api/workspaces',ids.viewer),f.env);
   assert.equal(response.status,200);const data=await response.json();
   assert.equal(data.workspaces.length,1);assert.equal(data.workspaces[0].id,ids.w1);
 }finally{f.db.close()}
});

test('cross-site writes are blocked, Viewer cannot invite, Admin cannot elevate to Admin',async()=>{
 const f=await fixture();try{
  const noOrigin=await handleRequest(f.request('POST','/api/workspaces/'+ids.w1+'/invitations',ids.owner,{email:'new@example.test',role:'viewer'},{origin:'https://attacker.invalid'}),f.env);
  assert.equal(noOrigin.status,403);
  const viewer=await handleRequest(f.request('POST','/api/workspaces/'+ids.w1+'/invitations',ids.viewer,{email:'new@example.test',role:'viewer'}),f.env);
  assert.equal(viewer.status,403);
  const admin=await handleRequest(f.request('POST','/api/workspaces/'+ids.w1+'/invitations',ids.admin,{email:'new@example.test',role:'admin'}),f.env);
  assert.equal(admin.status,400);
  const okay=await handleRequest(f.request('POST','/api/workspaces/'+ids.w1+'/invitations',ids.admin,{email:'new@example.test',role:'editor'}),f.env);
  assert.equal(okay.status,201);const j=await okay.json();assert.equal(j.role,'editor');assert.match(j.token,/^[A-Za-z0-9_-]{43}$/);
 }finally{f.db.close()}
});

test('acceptance requires exact invited email and one-time token, no cross-tenant role',async()=>{
 const f=await fixture();try{
  const email='invitee@example.test'; // already owns a distinct workspace, not yet member of Alpha
  const invited=await handleRequest(f.request('POST','/api/workspaces/'+ids.w1+'/invitations',ids.owner,{email,role:'viewer'}),f.env);
  assert.equal(invited.status,201);const {token}=await invited.json();
  const wrong=await handleRequest(f.request('POST','/api/invitations/accept',ids.viewer,{token}),f.env);
  assert.equal(wrong.status,404);
  const accepted=await handleRequest(f.request('POST','/api/invitations/accept',ids.invitee,{token}),f.env);
  assert.equal(accepted.status,200);assert.equal((await accepted.json()).role,'viewer');
  const replay=await handleRequest(f.request('POST','/api/invitations/accept',ids.invitee,{token}),f.env);
  assert.equal(replay.status,404);
  const data=await (await handleRequest(f.request('GET','/api/workspaces',ids.invitee),f.env)).json();
  assert.deepEqual(new Set(data.workspaces.map(w=>w.id)),new Set([ids.w1,ids.w2]));
 }finally{f.db.close()}
});

test('Owner cannot be demoted; Admin cannot touch another Admin; revoked memberships lose access',async()=>{
 const f=await fixture();try{
  const ownerAttempt=await handleRequest(f.request('PATCH','/api/workspaces/'+ids.w1+'/members/'+ids.owner,ids.admin,{role:'viewer'}),f.env);
  assert.equal(ownerAttempt.status,403);
  const adminAttempt=await handleRequest(f.request('PATCH','/api/workspaces/'+ids.w1+'/members/'+ids.admin,ids.admin,{revoke:true}),f.env);
  assert.equal(adminAttempt.status,403);
  const revoke=await handleRequest(f.request('PATCH','/api/workspaces/'+ids.w1+'/members/'+ids.viewer,ids.admin,{revoke:true}),f.env);
  assert.equal(revoke.status,200);
  const blocked=await handleRequest(f.request('GET','/api/workspaces/'+ids.w1+'/sermons',ids.viewer),f.env);
  assert.equal(blocked.status,404);
 }finally{f.db.close()}
});

test('revoked sessions cannot access any protected endpoints',async()=>{
 const f=await fixture();try{
  const res=await handleRequest(f.request('POST','/auth/logout',ids.viewer,{}),f.env);assert.equal(res.status,200);
  const after=await handleRequest(f.request('GET','/api/me',ids.viewer),f.env);assert.equal(after.status,401);
 }finally{f.db.close()}
});

test('Google start stores one-time state, sets secure callback cookie, no secrets in redirect',async()=>{
 const f=await fixture();try{
  const res=await handleRequest(f.request('GET','/auth/google/start'),f.env);
  assert.equal(res.status,303);
  const url=new URL(res.headers.get('location'));
  assert.equal(url.host,'accounts.google.com');
  assert.equal(url.searchParams.get('response_type'),'code');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.match(res.headers.get('set-cookie'),/HttpOnly/);
  const n=f.db.connection.prepare('SELECT COUNT(*) AS n FROM oauth_login_attempts').get().n;assert.equal(n,1);
 }finally{f.db.close()}
});

test('unconfigured app gives no auth or content exposure',async()=>{
 const f=await fixture();try{
  const env={DB:f.db};const res=await handleRequest(f.request('GET','/api/workspaces/'+ids.w1+'/sermons',ids.owner),env);
  assert.equal(res.status,503);assert.ok(!(await res.text()).includes('Alpha'));
 }finally{f.db.close()}
});

test('full mocked Google callback links approved subject, issues session, and rejects replay',async()=>{
 const f=await fixture(); const originalFetch=globalThis.fetch;
 try{
  const start=await handleRequest(f.request('GET','/auth/google/start'),f.env);
  assert.equal(start.status,303);
  const state=start.headers.get('set-cookie').match(/__Secure-sb_flow=([^;]+)/)?.[1];
  assert.ok(state);
  const login=f.db.connection.prepare('SELECT nonce FROM oauth_login_attempts').get();
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'fixture-key-2026',use:'sig',alg:'RS256'};
  const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const header=encode({alg:'RS256',typ:'JWT',kid:jwk.kid});
  const payload=encode({iss:'https://accounts.google.com',aud:f.env.GOOGLE_CLIENT_ID,iat:now,exp:now+3600,nonce:login.nonce,sub:'approved-google-subject',email:'owner@example.test',email_verified:true,name:'Owner'});
  const text=header+'.'+payload;
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(text));
  const idToken=text+'.'+Buffer.from(signature).toString('base64url');
  globalThis.fetch=async url=>{
    const value=String(url);
    if(value.includes('/token')) return new Response(JSON.stringify({id_token:idToken}),{status:200,headers:{'content-type':'application/json'}});
    if(value.includes('/certs')) return new Response(JSON.stringify({keys:[jwk]}),{status:200,headers:{'content-type':'application/json','cache-control':'max-age=60'}});
    throw Error('Unexpected network request');
  };
  const callbackPath='/auth/google/callback?code=fictional-code&state='+state;
  const callback=new Request(origin+callbackPath,{headers:{cookie:'__Secure-sb_flow='+state}});
  const complete=await handleRequest(callback,f.env);
  assert.equal(complete.status,303);
  const sessionToken=complete.headers.get('set-cookie')?.match(/__Host-sb_session=([^;]+)/)?.[1];
  assert.ok(sessionToken);
  const me=await handleRequest(new Request(origin+'/api/me',{headers:{cookie:'__Host-sb_session='+sessionToken}}),f.env);
  assert.equal(me.status,200);assert.equal((await me.json()).account.email_normalized,'owner@example.test');
  const again=await handleRequest(callback,f.env);assert.equal(again.status,401);
 }finally{globalThis.fetch=originalFetch;f.db.close()}
});

test('invite, accept and member-change DB failures return a generic 503 instead of rejecting',async()=>{
 const f=await fixture();try{
  const boom=async()=>{throw new Error('boom owner@example.test SELECT secret')};
  const realBatch=f.db.batch.bind(f.db),realPrepare=f.db.prepare.bind(f.db);
  const token=randomToken();
  const cases=[
   ['inviteMember',f.request('POST','/api/workspaces/'+ids.w1+'/invitations',ids.owner,{email:'new@example.test',role:'viewer'}),'batch'],
   ['acceptInvite',f.request('POST','/api/invitations/accept',ids.invitee,{token}),'invite-select'],
   ['manageMember',f.request('PATCH','/api/workspaces/'+ids.w1+'/members/'+ids.viewer,ids.admin,{revoke:true}),'batch']];
  for(const [name,request,mode] of cases){
   f.db.batch=mode==='batch'?boom:realBatch;
   f.db.prepare=sql=>{const stmt=realPrepare(sql);
    if(mode!=='invite-select'||!/FROM workspace_invitations i JOIN/i.test(sql))return stmt;
    return {bind:(...args)=>({...stmt.bind(...args),first:boom})}};
   const response=await handleRequest(request,f.env);
   assert.equal(response.status,503,name);
   const text=await response.text();assert.ok(!/boom|owner@|SELECT/.test(text),name);
  }
 }finally{f.db.close()}
});

test('async handler failures return a generic 503 instead of rejecting',async()=>{
 const f=await fixture();try{
  const realPrepare=f.db.prepare.bind(f.db);
  f.db.prepare=(sql)=>{const stmt=realPrepare(sql);
   if(!/FROM sermons|JOIN workspaces|FROM workspaces/i.test(sql))return stmt;
   return {bind:(...args)=>{const b=stmt.bind(...args);const fail=async()=>{throw new Error('boom owner@example.test SELECT secret')};return {...b,first:fail,all:fail,run:fail}}}};
  for(const [method,path,body] of [['GET','/api/workspaces/'+ids.w1+'/sermons'],['GET','/api/workspaces'],['POST','/api/workspaces',{name:'Fixture'}]]){
   const response=await handleRequest(f.request(method,path,ids.owner,body),f.env);
   assert.equal(response.status,503,method+' '+path);
   const text=await response.text();assert.ok(!/boom|owner@|SELECT/.test(text));
  }
 }finally{f.db.close()}
});
