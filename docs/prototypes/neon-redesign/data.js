// Realistic sample data for the Sermon Bank redesign prototype.
// Adapted from scripts/seed-staging.mjs and extended across three workspaces.

export const TODAY = '2026-11-22';

export const ACCOUNT = {
  id: 'acct-rico',
  display_name: 'Rico Santos',
  email: 'rico@favor.church'
};

export const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer'
};

export const SOURCE_LABELS = {
  google_doc: 'Google Doc',
  pdf: 'PDF',
  external: 'External link'
};

export const INDEXING_STATUS = {
  indexed: { label: 'Searchable', tone: 'positive' },
  awaiting_consent: { label: 'Awaiting consent', tone: 'warning' },
  queued: { label: 'Indexing', tone: 'neutral' },
  not_indexed: { label: 'Not indexed', tone: 'neutral' },
  failed: { label: 'Could not read', tone: 'danger' },
  revoked: { label: 'Revoked', tone: 'danger' }
};

export const ROLE_ABILITIES = [
  ['Read library, calendar and search', ['owner', 'admin', 'editor', 'viewer']],
  ['Create and edit sermons, log preachings', ['owner', 'admin', 'editor']],
  ['Upload PDFs and manage places', ['owner', 'admin', 'editor']],
  ['Invite members and change roles', ['owner', 'admin']],
  ['Allow or revoke PDF note search', ['owner']],
  ['Import history CSV and roll back rows', ['owner']]
];

const NOTES = {
  grace: `Opening. Paul asks three times for the thorn to be removed and hears one answer: "My grace is sufficient for you" (2 Corinthians 12:9). Grace is not a reward for strength. It arrives where strength runs out.

Point one: weakness is not a disqualification. Gideon, Moses and Ruth all began from a place they would not have chosen. Compare Philippians 4:13, which is about contentment, not winning.

Point two: sufficient does not mean easy. The daily bread of Exodus 16 came one morning at a time and could not be stored. Grace for today is for today.

Point three: boast in what you cannot fix. Strength shared is a gift to the room, and weakness shared is how a room becomes a family.

Closing question for the table: where are you asking for the thorn to be removed, and what would it look like to receive grace there instead?`,
  water: `Opening. The boat is already far from land and the wind is against it. Jesus comes to them in the fourth watch of the night, walking on the sea (Matthew 14:25).

Point one: Peter asks for the invitation before he steps out. "Lord, if it is you, command me to come to you on the water" (Matthew 14:28). Faith here is a response to a word, not a stunt.

Point two: he sinks when he looks at the wind. Notice that Jesus catches him at once and does not wait for him to be embarrassed enough.

Point three: the boat worships at the end. The ones who stayed put were not lesser, they were present. Reference for further reading: Psalm 107:23-30.`,
  shepherd: `Opening. Psalm 23 is read at funerals and sung at weddings because it holds both. The shepherd is not only a guide. The shepherd stays.

Verse by verse: green pastures and still waters are the rest he provides, the valley of the shadow is the place he walks beside us, the table is set in front of those who trouble us.

Cross reference: John 10:11, "I am the good shepherd." The good shepherd lays down his life, so staying is costly.

Application: who in the congregation needs someone to stay? Sit with them. Do not fix it.`,
  love: `Opening. First Corinthians 13 is the most quoted chapter nobody finishes reading. It was written to a church full of gifted, divided people.

Point one: gifts without love are noise. A gong and a cymbal can be heard across a room and warm no one.

Point two: love is patient and kind, and the list is practical. It does not keep a record of wrongs (1 Corinthians 13:5). Keeping score is the opposite of forgiving.

Point three: love is what remains. "Faith, hope and love abide, and the greatest of these is love" (1 Corinthians 13:13). Look ahead to Romans 12:9-18 for Monday morning.`,
  well: `Opening. A woman comes to a well at noon, the hour when nobody else is there. Jesus is already sitting at it (John 4:6).

Point one: he crosses every line of the day to be there, speaking to a Samaritan and a woman. Mercy goes first to the person we planned to avoid.

Point two: he tells her what she has done and does not leave. Truth and mercy arrive in the same sentence.

Cross reference: compare John 3:16, "God so loved the world", spoken at night to a teacher. The same love is spoken at noon to an outcast.`,
  hope: `Opening. Romans 8 does not say that all things are good. It says that God works in all things for the good of those who love him (Romans 8:28).

Point one: creation groans and so do we. Waiting is not weakness, it is the posture of people who expect something (Romans 8:23-25).

Point two: the Spirit prays when we cannot. Some seasons the best prayer is a sigh, and it is heard. Read Romans 8:38-39 slowly, with the lights low.`,
  table: `Opening. In the wilderness of Sin the people complain about hunger and God answers with bread. Exodus 16:4 says it rains from heaven, enough for the day.

Point one: manna is not a stockpile. Anything saved overnight spoiled, except on the sixth day. God teaches trust by teaching rhythm.

Point two: the bread points to a person. "I am the bread of life" (John 6:35). Whoever comes is fed and nobody is counted.`,
  youthAnchor: `Opening. Hebrews 6:19 calls hope an anchor for the soul, firm and secure. An anchor does not stop the tide; it holds the boat when the water pulls.

Point one: most anxiety in college and early work comes from trying to anchor yourself to outcomes you do not control. Compare Matthew 14:28 and John 3:16.`
};

export function createInitialWorkspaces() {
  return [
    {
      id: 'ws-riverbend',
      name: 'Riverbend Church',
      role: 'owner',
      places: [
        { id: 'pl-riverbend', display_name: 'Riverbend Chapel', aliases: ['Main Sanctuary'], event_count: 7 },
        { id: 'pl-riverbend-short', display_name: 'Riverbend', aliases: [], event_count: 2 },
        { id: 'pl-lakeside', display_name: 'Lakeside Hall', aliases: ['Lakeside'], event_count: 4 },
        { id: 'pl-hilltop', display_name: 'Hilltop Community Center', aliases: [], event_count: 3 }
      ],
      members: [
        { account_id: 'acct-rico', display_name: 'Rico Santos', email: 'rico@favor.church', role: 'owner', accepted_at: '2025-08-14' },
        { account_id: 'acct-hannah', display_name: 'Hannah Reyes', email: 'hannah@favor.church', role: 'admin', accepted_at: '2025-09-02' },
        { account_id: 'acct-caleb', display_name: 'Caleb Mendoza', email: 'caleb@favor.church', role: 'editor', accepted_at: '2025-11-19' },
        { account_id: 'acct-naomi', display_name: 'Naomi Villanueva', email: 'naomi@favor.church', role: 'viewer', accepted_at: '2026-02-07' }
      ],
      sermons: [
        {
          id: 'sermon-grace',
          title: 'Grace Enough for Today',
          series_name: 'Enough',
          scripture_references: ['2 Corinthians 12:7-10'],
          tags: ['weakness', 'pastoral'],
          description: 'Series opener on weakness and daily sufficiency. Draws on Paul’s thorn in the flesh alongside the daily rhythm of Exodus 16.',
          created_at: '2026-09-01 09:14:00',
          updated_at: '2026-11-09 14:20:00',
          archived_at: null,
          versions: [
            { id: 'v-grace-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-grace-original', indexing_state: 'indexed', notes: NOTES.grace },
            { id: 'v-grace-2', label: 'Short edit (28 min)', source_type: 'google_doc', google_document_id: 'demo-doc-grace-short', indexing_state: 'not_indexed', notes: null }
          ],
          preaching_events: [
            { id: 'ev-1', preached_on: '2026-10-11', date_precision: 'exact', place_id: 'pl-lakeside', place_name: 'Lakeside Hall', occasion: 'Evening service', version_id: 'v-grace-1', raw_date: null },
            { id: 'ev-2', preached_on: '2026-11-08', date_precision: 'exact', place_id: 'pl-riverbend', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', version_id: 'v-grace-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-water',
          title: 'Walking on Water',
          series_name: 'Enough',
          scripture_references: ['Matthew 14:22-33'],
          tags: ['faith', 'storms'],
          description: 'Faith as a response to an invitation rather than a stunt, and what Jesus does the moment Peter begins to sink.',
          created_at: '2026-09-08 08:40:00',
          updated_at: '2026-11-22 11:05:00',
          archived_at: null,
          versions: [
            { id: 'v-water-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-water-original', indexing_state: 'indexed', notes: NOTES.water }
          ],
          preaching_events: [
            { id: 'ev-3', preached_on: '2026-09-27', date_precision: 'exact', place_id: 'pl-riverbend', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', version_id: 'v-water-1', raw_date: null },
            { id: 'ev-3b', preached_on: '2026-11-22', date_precision: 'exact', place_id: 'pl-riverbend', place_name: 'Riverbend Chapel', occasion: 'Sunday morning (9:00 AM)', version_id: 'v-water-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-shepherd',
          title: 'The Shepherd Who Stays',
          series_name: '',
          scripture_references: ['Psalm 23', 'John 10:11'],
          tags: ['comfort', 'grief'],
          description: 'A pastoral walkthrough of Psalm 23 paired with John 10:11 on the cost of staying present in the valley.',
          created_at: '2026-08-04 10:12:00',
          updated_at: '2026-08-18 16:40:00',
          archived_at: null,
          versions: [
            { id: 'v-shep-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-shepherd-original', indexing_state: 'indexed', notes: NOTES.shepherd },
            { id: 'v-shep-2', label: 'Printed handout', source_type: 'pdf', indexing_state: 'awaiting_consent', notes: null }
          ],
          preaching_events: [
            { id: 'ev-4', preached_on: '2026-02-01', date_precision: 'needs_review', place_id: 'pl-riverbend-short', place_name: 'Riverbend', occasion: 'Sunday morning', version_id: 'v-shep-1', raw_date: '1 Feb 2026' },
            { id: 'ev-5', preached_on: '2026-08-16', date_precision: 'exact', place_id: 'pl-hilltop', place_name: 'Hilltop Community Center', occasion: 'Memorial gathering', version_id: 'v-shep-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-love',
          title: 'Love That Does Not Keep Score',
          series_name: 'Everyday Love',
          scripture_references: ['1 Corinthians 13:1-13'],
          tags: ['forgiveness', 'community'],
          description: 'Reading First Corinthians 13 in its original context: a gifted, divided church learning practical forgiveness.',
          created_at: '2026-07-14 09:30:00',
          updated_at: '2026-07-20 12:15:00',
          archived_at: null,
          versions: [
            { id: 'v-love-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-love-original', indexing_state: 'indexed', notes: NOTES.love }
          ],
          preaching_events: [
            { id: 'ev-6', preached_on: '2026-07-19', date_precision: 'exact', place_id: 'pl-lakeside', place_name: 'Lakeside Hall', occasion: 'Sunday morning', version_id: 'v-love-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-well',
          title: 'Mercy at the Well',
          series_name: '',
          scripture_references: ['John 4:1-26'],
          tags: ['hospitality', 'gospel'],
          description: 'Truth and mercy arriving in the same sentence at noon in Samaria, contrasted with Nicodemus at night.',
          created_at: '2026-06-02 11:05:00',
          updated_at: '2026-06-08 09:45:00',
          archived_at: null,
          versions: [
            { id: 'v-well-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-well-original', indexing_state: 'indexed', notes: NOTES.well }
          ],
          preaching_events: [
            { id: 'ev-7', preached_on: '2025-06-01', date_precision: 'month', place_id: null, place_name: '', occasion: 'Summer series', version_id: 'v-well-1', raw_date: 'June 2025' },
            { id: 'ev-8', preached_on: '2026-06-07', date_precision: 'exact', place_id: 'pl-hilltop', place_name: 'Hilltop Community Center', occasion: 'Women’s retreat', version_id: 'v-well-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-hope',
          title: 'Hope in the Waiting',
          series_name: 'Enough',
          scripture_references: ['Romans 8:18-30'],
          tags: ['suffering', 'prayer'],
          description: 'What it means for creation and believers to groan in hope, and how the Spirit prays when words run out.',
          created_at: '2026-05-12 08:50:00',
          updated_at: '2026-05-19 15:10:00',
          archived_at: null,
          versions: [
            { id: 'v-hope-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-hope-original', indexing_state: 'indexed', notes: NOTES.hope },
            { id: 'v-hope-2', label: '2024 revision', source_type: 'google_doc', google_document_id: 'demo-doc-hope-2024', indexing_state: 'revoked', notes: null }
          ],
          preaching_events: [
            { id: 'ev-9', preached_on: '2024-01-01', date_precision: 'year', place_id: 'pl-lakeside', place_name: 'Lakeside Hall', occasion: '', version_id: null, raw_date: '2024' },
            { id: 'ev-10', preached_on: '2026-05-17', date_precision: 'exact', place_id: 'pl-riverbend', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', version_id: 'v-hope-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-table',
          title: 'A Table in the Wilderness',
          series_name: 'Daily Bread',
          scripture_references: ['Exodus 16:1-18', 'John 6:35'],
          tags: ['provision', 'rhythm'],
          description: 'Manna as daily trust rather than stockpile, pointing ahead to Jesus as the bread of life.',
          created_at: '2026-04-07 09:00:00',
          updated_at: '2026-04-13 10:30:00',
          archived_at: null,
          versions: [
            { id: 'v-table-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-table-original', indexing_state: 'indexed', notes: NOTES.table }
          ],
          preaching_events: [
            { id: 'ev-11', preached_on: '2026-04-12', date_precision: 'exact', place_id: 'pl-riverbend-short', place_name: 'Riverbend', occasion: 'Community meal', version_id: 'v-table-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-seeds',
          title: 'Seeds and Soil',
          series_name: 'Parables of the Kingdom',
          scripture_references: ['Mark 4:1-20'],
          tags: ['discipleship'],
          description: 'Four kinds of hearing in Mark 4 and the quiet patience required for a harvest.',
          created_at: '2026-03-03 09:00:00',
          updated_at: '2026-03-09 13:20:00',
          archived_at: null,
          versions: [
            { id: 'v-seeds-1', label: 'Sunday outline (scan)', source_type: 'pdf', indexing_state: 'failed', notes: null }
          ],
          preaching_events: [
            { id: 'ev-12', preached_on: '2026-03-08', date_precision: 'exact', place_id: 'pl-riverbend', place_name: 'Riverbend Chapel', occasion: 'Sunday morning', version_id: 'v-seeds-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-loved',
          title: 'For God So Loved',
          series_name: '',
          scripture_references: ['John 3:16-21'],
          tags: ['gospel', 'nicodemus'],
          description: 'Passage metadata only: its notes are not indexed yet, so Scripture search finds it by passage metadata.',
          created_at: '2026-02-10 09:00:00',
          updated_at: '2026-02-14 11:00:00',
          archived_at: null,
          versions: [
            { id: 'v-loved-1', label: 'Original manuscript', source_type: 'google_doc', google_document_id: 'demo-doc-loved-original', indexing_state: 'not_indexed', notes: null }
          ],
          preaching_events: [
            { id: 'ev-13', preached_on: null, date_precision: 'unknown', place_id: null, place_name: '', occasion: '', version_id: null, raw_date: 'sometime in spring' }
          ]
        },
        {
          id: 'sermon-habakkuk',
          title: 'When the Room Goes Quiet',
          series_name: 'Enough',
          scripture_references: ['Habakkuk 3:17-19'],
          tags: ['lament', 'draft'],
          description: 'Draft outline for the final Sunday of the Enough series. Notes not uploaded yet.',
          created_at: '2026-11-18 16:15:00',
          updated_at: '2026-11-21 18:05:00',
          archived_at: null,
          versions: [],
          preaching_events: []
        },
        {
          id: 'sermon-quiet',
          title: 'Quiet Faith',
          series_name: '',
          scripture_references: ['1 Kings 19:9-13'],
          tags: ['burnout', 'elijah'],
          description: 'Elijah in the cave and the low whisper after the wind, earthquake, and fire.',
          created_at: '2025-11-03 09:00:00',
          updated_at: '2026-01-15 10:00:00',
          archived_at: '2026-01-15 10:00:00',
          versions: [
            { id: 'v-quiet-1', label: 'External outline', source_type: 'external', source_url: 'https://example.com/quiet-faith', indexing_state: 'not_indexed', notes: null }
          ],
          preaching_events: [
            { id: 'ev-14', preached_on: '2025-11-09', date_precision: 'exact', place_id: 'pl-hilltop', place_name: 'Hilltop Community Center', occasion: 'Sunday morning', version_id: 'v-quiet-1', raw_date: null }
          ]
        }
      ]
    },
    {
      id: 'ws-youth',
      name: 'Youth & Young Adults',
      role: 'editor',
      places: [
        { id: 'pl-loft', display_name: 'BGC Loft', aliases: ['The Loft'], event_count: 3 },
        { id: 'pl-camp', display_name: 'Tagaytay Camp Hall', aliases: [], event_count: 1 }
      ],
      members: [
        { account_id: 'acct-paolo', display_name: 'Paolo Cruz', email: 'paolo@favor.church', role: 'owner', accepted_at: '2025-10-01' },
        { account_id: 'acct-rico', display_name: 'Rico Santos', email: 'rico@favor.church', role: 'editor', accepted_at: '2025-10-03' }
      ],
      sermons: [
        {
          id: 'sermon-anchor',
          title: 'An Anchor That Holds',
          series_name: 'Unshaken',
          scripture_references: ['Hebrews 6:19-20'],
          tags: ['hope', 'campus'],
          description: 'Friday youth night opener on holding steady through university and early-career uncertainty.',
          created_at: '2026-10-14 14:00:00',
          updated_at: '2026-11-06 19:00:00',
          archived_at: null,
          versions: [
            { id: 'v-anchor-1', label: 'Friday night notes', source_type: 'google_doc', google_document_id: 'demo-doc-anchor', indexing_state: 'indexed', notes: NOTES.youthAnchor }
          ],
          preaching_events: [
            { id: 'ev-y1', preached_on: '2026-11-06', date_precision: 'exact', place_id: 'pl-loft', place_name: 'BGC Loft', occasion: 'Friday Youth Night', version_id: 'v-anchor-1', raw_date: null }
          ]
        },
        {
          id: 'sermon-called',
          title: 'Named Before You Achieved Anything',
          series_name: 'Unshaken',
          scripture_references: ['Matthew 3:16-17'],
          tags: ['identity'],
          description: 'The Father speaks delight over Jesus at the Jordan before a single miracle is performed.',
          created_at: '2026-10-21 15:00:00',
          updated_at: '2026-10-24 10:00:00',
          archived_at: null,
          versions: [
            { id: 'v-called-1', label: 'Camp outline', source_type: 'pdf', indexing_state: 'awaiting_consent', notes: null }
          ],
          preaching_events: [
            { id: 'ev-y2', preached_on: '2026-10-24', date_precision: 'exact', place_id: 'pl-camp', place_name: 'Tagaytay Camp Hall', occasion: 'Youth Retreat Session 2', version_id: 'v-called-1', raw_date: null }
          ]
        }
      ]
    },
    {
      id: 'ws-collective',
      name: 'Manila Teaching Collective',
      role: 'viewer',
      places: [
        { id: 'pl-makati', display_name: 'Makati Main Hall', aliases: [], event_count: 2 }
      ],
      members: [
        { account_id: 'acct-elena', display_name: 'Elena Bautista', email: 'elena@favor.church', role: 'owner', accepted_at: '2025-06-12' },
        { account_id: 'acct-rico', display_name: 'Rico Santos', email: 'rico@favor.church', role: 'viewer', accepted_at: '2026-01-19' }
      ],
      sermons: [
        {
          id: 'sermon-city',
          title: 'Seek the Peace of the City',
          series_name: 'Exiles & Builders',
          scripture_references: ['Jeremiah 29:4-7'],
          tags: ['vocation', 'city'],
          description: 'Shared teaching workspace for partner pastors in Metro Manila. View-only workspace example.',
          created_at: '2026-08-19 09:00:00',
          updated_at: '2026-09-14 11:30:00',
          archived_at: null,
          versions: [
            { id: 'v-city-1', label: 'Shared transcript', source_type: 'google_doc', google_document_id: 'demo-doc-city', indexing_state: 'indexed', notes: 'Jeremiah 29:7 calls exiles to build houses, plant gardens, and pray for the welfare of the city where God has sent them. Grace and patience shape public witness.' }
          ],
          preaching_events: [
            { id: 'ev-c1', preached_on: '2026-09-13', date_precision: 'exact', place_id: 'pl-makati', place_name: 'Makati Main Hall', occasion: 'Combined Sunday', version_id: 'v-city-1', raw_date: null }
          ]
        }
      ]
    }
  ];
}

// Date & formatting helpers
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`;
}

export function formatLongDay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dt.getUTCDay()];
  return `${wd}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatWhen(iso, precision) {
  if (precision === 'unknown' || !iso) return 'Date unknown';
  const [y, m] = iso.slice(0, 10).split('-').map(Number);
  if (precision === 'year') return String(y);
  if (precision === 'month') return `${MONTHS[m - 1]} ${y}`;
  return formatDay(iso);
}

export function latestEvent(sermon) {
  const dated = (sermon.preaching_events || []).filter(e => e.preached_on);
  if (!dated.length) return null;
  return dated.slice().sort((a, b) => b.preached_on.localeCompare(a.preached_on))[0];
}

export function seriesSwatchIndex(name) {
  if (!name) return 5;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 6;
}

// Client-side search engine matching Scripture metadata and indexed note text
const BIBLE_BOOKS = [
  'genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua', 'judges', 'ruth',
  '1 samuel', '2 samuel', '1 kings', '2 kings', '1 chronicles', '2 chronicles', 'ezra', 'nehemiah', 'esther',
  'job', 'psalm', 'psalms', 'proverbs', 'ecclesiastes', 'song of solomon', 'isaiah', 'jeremiah', 'lamentations',
  'ezekiel', 'daniel', 'hosea', 'joel', 'amos', 'obadiah', 'jonah', 'micah', 'nahum', 'habakkuk', 'zephaniah',
  'haggai', 'zechariah', 'malachi', 'matthew', 'mark', 'luke', 'john', 'acts', 'romans',
  '1 corinthians', '2 corinthians', 'galatians', 'ephesians', 'philippians', 'colossians',
  '1 thessalonians', '2 thessalonians', '1 timothy', '2 timothy', 'titus', 'philemon',
  'hebrews', 'james', '1 peter', '2 peter', '1 john', '2 john', '3 john', 'jude', 'revelation'
];

export function isBibleReference(query) {
  const clean = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return BIBLE_BOOKS.some(book => {
    if (!clean.startsWith(book)) return false;
    const rest = clean.slice(book.length).trim();
    return rest === '' || /^\d+(:\d+(-\d+)?)?$/.test(rest);
  });
}

function makeExcerpt(text, needle) {
  const lower = text.toLowerCase();
  const qLower = needle.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx < 0) return null;
  const start = Math.max(0, idx - 75);
  const end = Math.min(text.length, idx + needle.length + 115);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const slice = text.slice(start, end).replace(/\n+/g, ' ');
  return { text: prefix + slice + suffix, query: needle };
}

function countOccurrences(text, needle) {
  const lower = text.toLowerCase();
  const q = needle.toLowerCase();
  let count = 0;
  let pos = 0;
  while ((pos = lower.indexOf(q, pos)) !== -1) {
    count++;
    pos += q.length;
  }
  return count;
}

export function runWorkspaceSearch(workspace, query, { scope = 'everything', includeArchived = false } = {}) {
  const q = (query || '').trim();
  const ref = isBibleReference(q);
  if (!q) return { q, isRef: false, needsReference: false, metadata: [], notes: [] };
  if (scope === 'bible' && !ref) return { q, isRef: false, needsReference: true, metadata: [], notes: [] };

  const sermons = workspace.sermons.filter(s => includeArchived || !s.archived_at);
  const qLower = q.toLowerCase();
  const metadata = [];
  const notes = [];

  for (const s of sermons) {
    if (scope !== 'notes') {
      const matchedRef = (s.scripture_references || []).find(r => r.toLowerCase().includes(qLower) || qLower.includes(r.toLowerCase().split(':')[0]));
      if (matchedRef && (ref ? matchedRef.toLowerCase().includes(qLower.split(':')[0]) : matchedRef.toLowerCase().includes(qLower))) {
        metadata.push({ sermon: s, passage: matchedRef });
      }
    }
    for (const v of s.versions || []) {
      if (v.indexing_state === 'indexed' && v.notes) {
        const count = countOccurrences(v.notes, q);
        if (count > 0) {
          notes.push({
            sermon: s,
            version: v,
            match_count: count,
            excerpt: makeExcerpt(v.notes, q)
          });
        }
      }
    }
  }
  return { q, isRef: ref, needsReference: false, metadata, notes };
}

export function runSermonNoteSearch(sermon, query) {
  const q = (query || '').trim();
  return (sermon.versions || []).map(v => {
    if (v.indexing_state !== 'indexed' || !v.notes) {
      return { version: v, status: 'not_searchable', match_count: 0, excerpts: [] };
    }
    const count = countOccurrences(v.notes, q);
    if (!count) return { version: v, status: 'not_in_notes', match_count: 0, excerpts: [] };
    const excerpts = [];
    const lower = v.notes.toLowerCase();
    const qLower = q.toLowerCase();
    let pos = 0;
    while (excerpts.length < 3 && (pos = lower.indexOf(qLower, pos)) !== -1) {
      const start = Math.max(0, pos - 65);
      const end = Math.min(v.notes.length, pos + q.length + 100);
      excerpts.push({
        text: (start > 0 ? '…' : '') + v.notes.slice(start, end).replace(/\n+/g, ' ') + (end < v.notes.length ? '…' : ''),
        query: q
      });
      pos += q.length + 60;
    }
    return { version: v, status: 'matched', match_count: count, excerpts };
  });
}
