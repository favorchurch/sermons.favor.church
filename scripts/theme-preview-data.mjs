// Local-only preview data, adapted from docs/prototypes/neon-redesign/data.js.
export const PREVIEW_OWNER = { id: 'a1000000-0000-4000-8000-000000000001', email: 'preview@example.test', name: 'Preview Owner' };
const uuid = n => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SERMONS = [
  ['Grace Enough for Today','Enough','2 Corinthians 12:7-10','2026-01-11','Riverbend Chapel','Grace is sufficient for today. Paul learns that weakness is not a disqualification.'],
  ['Walking on Water','Enough','Matthew 14:22-33','2026-02-08','Riverbend Chapel','Faith responds to an invitation, not a stunt. Jesus catches Peter at once.'],
  ['The Shepherd Who Stays','','Psalm 23; John 10:11','2026-03-15','Lakeside Hall','The shepherd stays with us through green pastures and the valley.'],
  ['Love That Does Not Keep Score','Everyday Love','1 Corinthians 13:1-13','2026-04-12','Riverbend Chapel','Love is patient and kind; it does not keep a record of wrongs.'],
  ['Mercy at the Well','','John 4:1-26','2026-05-10','Hilltop Community Center','Truth and mercy arrive in the same sentence at the well.'],
  ['Hope in the Waiting','Enough','Romans 8:18-30','2026-06-14','Riverbend Chapel','Creation groans and so do we. Waiting is the posture of people who expect.'],
  ['A Table in the Wilderness','Daily Bread','Exodus 16:1-18; John 6:35','2026-07-12','Lakeside Hall','Manna teaches trust by teaching rhythm: enough for today.'],
  ['Seeds and Soil','Parables of the Kingdom','Mark 4:1-20','2026-08-09','Riverbend Chapel','The quiet patience required for a harvest begins with listening.'],
  ['For God So Loved','','John 3:16-21','2026-09-13','Hilltop Community Center','God so loved the world; grace goes first to the person we planned to avoid.'],
  ['When the Room Goes Quiet','Enough','Habakkuk 3:17-19','2026-10-11','Riverbend Chapel','Even when the fig tree does not blossom, we can rejoice in the Lord.'],
  ['An Anchor That Holds','Unshaken','Hebrews 6:19-20','2026-11-06','BGC Loft','Hope is an anchor for the soul, firm and secure through every season.'],
  ['Named Before You Achieved Anything','Unshaken','Matthew 3:16-17','2026-12-06','Tagaytay Camp Hall','The Father speaks delight before a single miracle is performed.']
];

export function seedPreviewData(db, { empty = false, layout = 'a' } = {}) {
  if (!['a', 'c', 'original'].includes(layout)) throw new Error('Unsupported preview layout');
  const owner = PREVIEW_OWNER;
  db.execute('INSERT INTO user_accounts(id,email_normalized,display_name,layout_theme) VALUES (?,?,?,?)', [owner.id, owner.email, owner.name, layout]);
  const workspaces = [
    { id: 'c1000000-0000-4000-8000-000000000001', name: 'Riverbend Church', records: SERMONS.slice(0, 10) },
    { id: 'c1000000-0000-4000-8000-000000000002', name: 'Youth & Young Adults', records: SERMONS.slice(10) }
  ];
  workspaces.forEach(workspace => {
    db.execute('INSERT INTO workspaces(id,name,owner_account_id) VALUES (?,?,?)', [workspace.id, workspace.name, owner.id]);
    db.execute("INSERT INTO workspace_memberships(workspace_id,account_id,role,accepted_at) VALUES (?,?,'owner',CURRENT_TIMESTAMP)", [workspace.id, owner.id]);
  });
  const places = [
    ['d1000000-0000-4000-8000-000000000001', workspaces[0].id, 'Riverbend Chapel'],
    ['d1000000-0000-4000-8000-000000000002', workspaces[0].id, 'Lakeside Hall'],
    ['d1000000-0000-4000-8000-000000000003', workspaces[0].id, 'Hilltop Community Center'],
    ['d1000000-0000-4000-8000-000000000004', workspaces[1].id, 'BGC Loft'],
    ['d1000000-0000-4000-8000-000000000005', workspaces[1].id, 'Tagaytay Camp Hall']
  ];
  for (const [id, workspaceId, name] of places) db.execute('INSERT INTO places(id,workspace_id,display_name) VALUES (?,?,?)', [id, workspaceId, name]);
  if (empty) return;
  const placeId = name => places.find(place => place[2] === name)[0];
  let sermonNo = 0;
  for (const workspace of workspaces) for (const [title, series, passage, date, place, notes] of workspace.records) {
    sermonNo++;
    const sermonId = uuid(sermonNo), versionId = `e1000000-0000-4000-8000-${String(sermonNo).padStart(12, '0')}`;
    db.execute('INSERT INTO sermons(id,workspace_id,title,scripture_passage,series_name,description) VALUES (?,?,?,?,?,?)', [sermonId, workspace.id, title, passage, series, notes]);
    for (const [position, reference] of passage.split(';').map(ref => ref.trim()).entries()) db.execute('INSERT INTO sermon_scripture_refs(workspace_id,sermon_id,position,reference_text) VALUES (?,?,?,?)', [workspace.id, sermonId, position, reference]);
    db.execute("INSERT INTO sermon_versions(id,workspace_id,sermon_id,label,source_type,google_document_id,index_consent_by,index_consent_at,indexing_state) VALUES (?,?,?,'Original manuscript','google_doc',?,?,CURRENT_TIMESTAMP,'indexed')", [versionId, workspace.id, sermonId, `preview-document-${sermonNo}`, owner.id]);
    db.execute('INSERT INTO note_texts(workspace_id,sermon_id,version_id,body,consent_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)', [workspace.id, sermonId, versionId, notes]);
    db.execute("INSERT INTO preaching_events(id,workspace_id,sermon_id,version_id,place_id,preached_on,date_precision) VALUES (?,?,?,?,?,?,'exact')", [uuid(100 + sermonNo), workspace.id, sermonId, versionId, placeId(place), date]);
  }
}
