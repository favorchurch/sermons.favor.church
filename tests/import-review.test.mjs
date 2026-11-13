import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, ids } from './helpers/library-fixture.mjs';

const csv = await readFile(new URL('./fixtures/anonymous-history.csv', import.meta.url), 'utf8');
async function setup(f) {
  const upload = await f.call('POST', f.w('/imports'), 'owner', { csv });
  assert.equal(upload.status, 201, upload.text);
  const id = upload.json.id;
  const path = `/imports/${id}`;
  const list = await f.call('GET', f.w(`${path}/rows`), 'owner');
  assert.equal(list.status, 200, list.text);
  return { id, path, rows: list.json.rows };
}
const action = (f, path, id, name) => f.call('POST', f.w(`${path}/rows/${id}/${name}`), 'owner');
const attest = (f, path, ids) => f.call('POST', f.w(`${path}/attest`), 'owner', { row_ids: ids });

test('upload is workspace scoped, replay safe, and retains provenance and reconciliation counts', async () => {
  const f = await fixture();
  try {
    const { id, path, rows } = await setup(f);
    const again = await f.call('POST', f.w('/imports'), 'owner', { csv });
    assert.deepEqual(again.json, { id, reused: true });
    const other = await f.call('POST', `/api/workspaces/${ids.w2}/imports`, 'owner2', { csv });
    assert.equal(other.status, 201);
    assert.notEqual(other.json.id, id);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].source_row, 5);
    assert.equal(rows[0].source_sheet, 'All History');
    assert.match(rows[0].source_hash, /^[0-9a-f]{64}$/);
    assert.ok(rows[0].flags.includes('first_day_precision_review'));
    assert.ok(rows.every(r => r.flags.includes('unknown_owner')));
    const raw = f.db.query('SELECT original_values_json FROM import_review_rows WHERE id=?', [rows[0].id])[0];
    assert.equal(JSON.parse(raw.original_values_json)[1], 'A New Beginning, Again');
    assert.equal('original_values_json' in rows[0], false);
    const summary = await f.call('GET', f.w(`${path}/summary`), 'owner');
    assert.deepEqual(summary.json, { total: 4, parsed: 3, invalid: 1, flagged: 4, attested: 0, approved: 0 });
  } finally { f.db.close(); }
});

test('attestation gates approval, repeated approval creates nothing, and rollback preserves edits', async () => {
  const f = await fixture();
  try {
    const { path, rows } = await setup(f);
    const first = rows[0].id, second = rows[1].id;
    assert.equal((await action(f,path,first,'approve')).status,409);
    assert.equal((await attest(f,path,[first,second])).status,200);
    assert.equal((await action(f,path,first,'approve')).json.created,true);
    assert.equal((await action(f,path,first,'approve')).json.created,false);
    assert.equal((await action(f,path,second,'approve')).json.created,true);
    assert.equal(f.db.query('SELECT id FROM sermons WHERE source_import_row_id IS NOT NULL').length,2);
    const firstRecord = f.db.query('SELECT sermon_id,event_id FROM import_review_rows WHERE id=?',[first])[0];
    const secondRecord = f.db.query('SELECT sermon_id,event_id FROM import_review_rows WHERE id=?',[second])[0];
    const edit = await f.call('PATCH',f.w(`/sermons/${secondRecord.sermon_id}`),'owner',{title:'Edited'});
    assert.equal(edit.status,200);
    assert.deepEqual((await action(f,path,second,'rollback')).json,{rolled_back:false,conflict:true});
    assert.equal(f.db.query('SELECT id FROM sermons WHERE id=?',[secondRecord.sermon_id]).length,1);
    assert.deepEqual((await action(f,path,first,'rollback')).json,{rolled_back:true,conflict:false});
    assert.equal(f.db.query('SELECT id FROM sermons WHERE id=?',[firstRecord.sermon_id]).length,0);
    assert.equal(f.db.query('SELECT id FROM preaching_events WHERE id=?',[firstRecord.event_id]).length,0);
    assert.equal(f.db.query('SELECT id FROM preaching_events WHERE id=?',[secondRecord.event_id]).length,1);
    assert.equal(f.db.query('SELECT id FROM sermons WHERE id=?',[ids.sermon1]).length,1);
    const summary = await f.call('GET', f.w(`${path}/summary`), 'owner');
    assert.equal(summary.json.attested,2);
    assert.equal(summary.json.approved,0);
  } finally { f.db.close(); }
});

test('only the owner can use every import route, and no private source reaches console output', async () => {
  const f = await fixture();
  const old = { log: console.log, error: console.error, warn: console.warn };
  const output = [];
  for (const key of Object.keys(old)) console[key] = (...args) => output.push(args.join(' '));
  try {
    const {path,rows} = await setup(f);
    const paths = [['POST','/imports',{csv}],['GET',`${path}/summary`],['GET',`${path}/rows`],['POST',`${path}/attest`,{row_ids:[rows[0].id]}],...['ignore','approve','rollback'].map(x=>['POST',`${path}/rows/${rows[0].id}/${x}`])];
    for (const [method,p,body] of paths) {
      for (const role of ['admin','editor','viewer']) assert.equal((await f.call(method,f.w(p),role,body)).status,403,`${role} ${p}`);
      assert.equal((await f.call(method,f.w(p),'outsider',body)).status,404,`outsider ${p}`);
      assert.equal((await f.call(method,`/api/workspaces/${ids.w2}${p}`,'owner2',body)).status, p === '/imports' ? 201 : 404,`other workspace ${p}`);
    }
    assert.ok(!output.join('\n').includes('A New Beginning, Again'));
  } finally { Object.assign(console, old); f.db.close(); }
});

test('duplicate flags require title, date and place and alias matches are flagged', async () => {
  const f = await fixture();
  try {
    f.db.execute('INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES(?,?,?)',[ids.w1,ids.place1,'The Harbor']);
    const input = 'Date Preached,Sermon Title,Category,Tags,Stories Shared,Location\n3/9/2025,Alpha Hope Sermon,c,t,n,The Harbor\n3/10/2025,Alpha Hope Sermon,c,t,n,The Harbor\n3/9/2025,Alpha Hope Sermon,c,t,n,The Harbor\n';
    const up = await f.call('POST',f.w('/imports'),'owner',{csv:input});
    assert.equal(up.status,201,up.text);
    const list = await f.call('GET',f.w(`/imports/${up.json.id}/rows`),'owner');
    assert.ok(list.json.rows[0].flags.includes('venue_alias'));
    assert.ok(list.json.rows[0].flags.includes('suspected_duplicate_event'));
    assert.ok(!list.json.rows[1].flags.includes('suspected_duplicate_event'));
    assert.ok(list.json.rows[2].flags.includes('suspected_duplicate_event'));
  } finally { f.db.close(); }
});

test('attests a selection larger than the ordinary JSON body limit', async () => {
  const f = await fixture();
  try {
    const {path,id} = await setup(f);
    const insert = `INSERT INTO import_review_rows(id,workspace_id,batch_id,source_sheet,source_row,source_hash,original_values_json,parse_outcome,review_flags_json) VALUES(?,?,?,?,?,?,?,'parsed','[]')`;
    const idsToAttest = [];
    for (let n = 0; n < 210; n++) {
      const rowId = crypto.randomUUID();
      idsToAttest.push(rowId);
      f.db.execute(insert,[rowId,ids.w1,id,'All History',100+n,'hash','[]']);
    }
    const response = await attest(f,path,idsToAttest);
    assert.equal(response.status,200,response.text);
    assert.equal(response.json.attested,210);
  } finally { f.db.close(); }
});

test('mixed aliases identify the same place when finding in-batch duplicates', async () => {
  const f = await fixture();
  try {
    f.db.execute('INSERT INTO place_aliases(workspace_id,place_id,alias) VALUES(?,?,?)',[ids.w1,ids.place1,'The Harbor']);
    const input = 'Date Preached,Sermon Title,Category,Tags,Stories Shared,Location\n1/2/2024,Unique,c,t,n,Harbor Chapel\n1/2/2024,Unique,c,t,n,The Harbor\n';
    const up = await f.call('POST',f.w('/imports'),'owner',{csv:input});
    const list = await f.call('GET',f.w(`/imports/${up.json.id}/rows`),'owner');
    assert.ok(list.json.rows[1].flags.includes('suspected_duplicate_event'));
  } finally { f.db.close(); }
});

test('ignored and rolled-back rows can be explicitly attested for another review', async () => {
  const f = await fixture();
  try {
    const {path,rows} = await setup(f);
    const rowId = rows[0].id;
    assert.equal((await action(f,path,rowId,'ignore')).status,200);
    assert.equal((await attest(f,path,[rowId])).status,200);
    assert.equal((await action(f,path,rowId,'approve')).status,200);
    assert.equal((await action(f,path,rowId,'rollback')).json.rolled_back,true);
    assert.equal((await attest(f,path,[rowId])).status,200);
    assert.equal((await action(f,path,rowId,'approve')).json.created,true);
    assert.equal(f.db.query('SELECT id FROM preaching_events WHERE source_import_row_id=?',[rowId]).length,1);
  } finally { f.db.close(); }
});

test('competing state transitions cannot partially attest or falsely report ignore', async () => {
  const f = await fixture();
  try {
    const {path,rows} = await setup(f);
    const original = f.db.batch.bind(f.db);
    let mutate = true;
    f.db.batch = async statements => {
      if (mutate) {
        mutate = false;
        f.db.execute("UPDATE import_review_rows SET status='approved',attested_by=?,attested_at=CURRENT_TIMESTAMP WHERE id=?",[ids.owner,rows[1].id]);
      }
      return original(statements);
    };
    assert.equal((await attest(f,path,[rows[0].id,rows[1].id])).status,409);
    assert.equal(f.db.query('SELECT status FROM import_review_rows WHERE id=?',[rows[0].id])[0].status,'unreviewed');
    mutate = true;
    f.db.batch = async statements => {
      if (mutate) {
        mutate = false;
        f.db.execute("UPDATE import_review_rows SET status='approved',attested_by=?,attested_at=CURRENT_TIMESTAMP WHERE id=?",[ids.owner,rows[0].id]);
      }
      return original(statements);
    };
    assert.equal((await action(f,path,rows[0].id,'ignore')).status,409);
    assert.equal(f.db.query('SELECT status FROM import_review_rows WHERE id=?',[rows[0].id])[0].status,'approved');
  } finally { f.db.close(); }
});

test('rows without a date or place can be attested and approved without creating a place', async () => {
  const f = await fixture();
  try {
    const input = 'Date Preached,Sermon Title,Category,Tags,Stories Shared,Location\n,Undated Placeless,c,t,n,\n';
    const up = await f.call('POST',f.w('/imports'),'owner',{csv:input});
    assert.equal(up.status,201,up.text);
    const list = await f.call('GET',f.w(`/imports/${up.json.id}/rows`),'owner');
    const row = list.json.rows[0];
    assert.ok(row.flags.includes('undated'));
    const placesBefore = f.db.query('SELECT id FROM places').length;
    const path = `/imports/${up.json.id}`;
    assert.equal((await attest(f,path,[row.id])).status,200);
    assert.equal((await action(f,path,row.id,'approve')).json.created,true);
    const event = f.db.query('SELECT place_id,preached_on,date_precision FROM preaching_events WHERE source_import_row_id=?',[row.id])[0];
    assert.deepEqual({...event},{place_id:null,preached_on:null,date_precision:'unknown'});
    assert.equal(f.db.query('SELECT id FROM places').length,placesBefore);
  } finally { f.db.close(); }
});
