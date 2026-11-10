/* Sermon Bank Phase C — standalone, offline interaction prototype.
   Runs after selected-workspace.html's fictional data bootstrap. No real auth,
   APIs, documents, storage or email; never write to Google Drive or PDF bytes. */
(function(){
'use strict';
const root=document.getElementById('app');
const data0=sermons;
const datasets={
  main:{id:'main',name:"Pastor Morgan's archive",role:'Owner',items:data0,members:[{name:'Pastor Morgan',role:'Owner'},{name:'Jo Reyes',role:'Editor'},{name:'Sam Quinn',role:'Viewer'}]},
  guest:{id:'guest',name:'Riverlight Study Archive',role:'Editor',items:[],members:[{name:'Pastor Riley',role:'Owner'},{name:'Pastor Morgan',role:'Editor'}]}
};
let active='main',state='ready',showArchived=false,lastFocused=null,dialogOpen=false,aliases={},importRows=[
{id:'M-001',title:'Untitled historical record',flags:['Unverified owner','Missing title'],source:'Original archive item 001',status:'Needs review',note:''},
{id:'M-002',title:'Possible sermon duplicate',flags:['Duplicate candidate'],source:'Original archive item 002',status:'Needs review',note:''},
{id:'M-003',title:'Uncertain church location',flags:['Ambiguous place'],source:'Original archive item 003',status:'Needs review',note:''}
];
const $=id=>document.getElementById(id);
const allowedEdit=()=>role!=='Viewer';
const allowedMembers=()=>role==='Owner'||role==='Admin';
const allowedOwner=()=>role==='Owner';
const current=()=>datasets[active];
const statuses={Indexed:['Indexed',''],Indexing:['Indexing','warn'],Revoked:['Access revoked','danger'],'Awaiting owner consent':['Awaiting consent','warn'],'Pending upload':['Upload pending','warn'],'Link only':['Link only','muted'],'Not indexed':['Not indexed','muted'],'Awaiting indexing':['Indexing queued','warn']};
const safe=s=>esc(s??'');
const att=(k,v)=>' '+k+'="'+safe(v)+'"';
const format=d=>d?formatDate(d):'Not preached yet';
const totalPlaces=()=>uniq([...customPlaces,...sermons.flatMap(s=>s.preached.map(p=>p.place))]);
const lastDate=s=>s.preached.length?s.preached.map(p=>p.date).sort().at(-1):null;
const validIndexed=v=>v.status==='Indexed' && v.ownerConsent!==false;
const getSermon=id=>sermons.find(s=>s.id===Number(id));
const idxStatus=s=>{if(s.versions.some(validIndexed))return 'Indexed';if(s.versions.some(v=>v.status==='Revoked'))return 'Revoked';if(s.versions.some(v=>v.status==='Awaiting owner consent'))return 'Awaiting owner consent';if(s.versions.some(v=>v.status==='Pending upload'))return 'Pending upload';if(s.versions.some(v=>['Indexing','Awaiting indexing'].includes(v.status)))return 'Indexing';return 'Link only'};
const tag=st=>{const p=statuses[st]||[st,'muted'];return '<span class="status-tag '+p[1]+'">'+safe(p[0])+'</span>'};
const help='<div class="readonly"><b>Source protection:</b> This app changes only sermon records, version references, and preaching details. It never edits an original Google Doc or overwrites a PDF. Every action in this preview is local and temporary.</div>';
const restricted=msg=>'<div class="alert error"><b>Access restricted.</b> '+safe(msg)+'</div>';
const empty=msg=>'<div class="empty-state"><h3>Nothing here yet.</h3><p>'+safe(msg)+'</p><button class="btn" data-c="clear">Clear filters</button></div>';
const formActions=(label)=>'<div class="dialog-actions"><button class="btn" type="button" data-c="close">Cancel</button><button class="btn primary" type="submit">'+label+'</button></div>';
const input=(name,label,value='',extra='')=>'<label>'+label+'<input name="'+name+'" value="'+safe(value)+'" '+extra+'></label>';
function announce(x){toast(x)}
function dialog(title,desc,body){
  lastFocused=document.activeElement;
  $('dialog').setAttribute('role','dialog');$('dialog').setAttribute('aria-modal','true');$('dialog').setAttribute('aria-labelledby','dialog-title');$('dialog').setAttribute('tabindex','-1');
  $('dialog').innerHTML='<header><div><div class="eyebrow">Sermon Bank · Prototype flow</div><h2 id="dialog-title">'+title+'</h2><p>'+desc+'</p></div><button class="x" type="button" data-c="close" aria-label="Close dialog">×</button></header>'+body;
  $('overlay').classList.add('open');document.body.style.overflow='hidden';dialogOpen=true;
  const first=$('dialog').querySelector('input:not([type=hidden]),select,textarea,button');if(first)first.focus();else $('dialog').focus();
}
closeDialog=function(){
  $('overlay').classList.remove('open');document.body.style.overflow='';dialogOpen=false;
  if(lastFocused && document.contains(lastFocused) && typeof lastFocused.focus==='function')lastFocused.focus();
};
function demoBar(){
 return '<div class="demo-toolbar"><strong>Try UI states:</strong><label for="phase-state" class="hidden">Demo state</label><select id="phase-state" aria-label="Preview state"><option value="ready" '+(state==='ready'?'selected':'')+'>Ready</option><option value="loading" '+(state==='loading'?'selected':'')+'>Loading</option><option value="empty" '+(state==='empty'?'selected':'')+'>Empty</option><option value="error" '+(state==='error'?'selected':'')+'>Service error</option><option value="denied" '+(state==='denied'?'selected':'')+'>Access denied</option><option value="revoked" '+(state==='revoked'?'selected':'')+'>Source revoked</option></select><button type="button" data-c="reset">Reset demo</button><span class="right">Fictional data · never saved · no real OAuth</span></div>';
}
hero=function(){
 const headings={Archive:'Your sermon library',History:'Every preaching, remembered',Places:'Your places',Settings:'Workspace settings'};
 const descriptions={Archive:'Find a message, manage its versions, and record every occasion it was preached.',History:'One sermon master. Multiple dates, venues and document versions.',Places:'Make one change to a location and reflect it in every linked preaching.',Settings:'Manage workspace access, Google indexing consent, private imports and exports.'};
 const primary=page==='Archive'?'<button class="btn primary" data-c="add" '+(!allowedEdit()?'disabled title="Viewers have read-only access"':'')+'>+ Add sermon</button>':page==='History'?'<button class="btn primary" data-c="preaching" '+(!allowedEdit()?'disabled':'')+'>+ Log preaching</button>':page==='Places'?'<button class="btn primary" data-c="place" '+(!allowedEdit()?'disabled':'')+'>+ Add place</button>':'';
 $('hero').innerHTML='<div><div class="eyebrow">'+safe(current().name)+' / private workspace</div><h1>'+headings[page]+'</h1><p>'+descriptions[page]+'</p></div>'+primary;
};
filtered=function(){
 const q=keyword.toLowerCase().trim();const group=sermons.filter(s=>Boolean(s.archived)===showArchived);
 return group.filter(s=>(!placeFilter||s.preached.some(p=>p.place===placeFilter))&&(!yearFilter||s.preached.some(p=>p.date.startsWith(yearFilter)))&&(!q||[s.title,s.scripture,s.series,(s.tags||[]).join(' '),s.description||'',...s.preached.flatMap(p=>[p.place,p.occasion,p.date,...(aliases[p.place]||[])].filter(Boolean)),...(s.versions.some(validIndexed)?[s.excerpt||'']:[])].join(' ').toLowerCase().includes(q)));
};
hitSnippet=function(s){
 const q=keyword.toLowerCase().trim(),body=s.excerpt||'';
 if(!q||!s.versions.some(validIndexed))return '';
 const at=body.toLowerCase().indexOf(q);if(at<0)return '';
 return '<div class="section-note" style="margin:8px 0 0"><b>Indexed note match:</b> '+safe(body.slice(0,at))+'<mark>'+safe(body.slice(at,at+q.length))+'</mark>'+safe(body.slice(at+q.length))+'</div>';
};
workspace=function(items){
 return '<div class="workspace-list" role="table" aria-label="Sermons"><div class="workspace-row column-headers" role="row"><span role="columnheader">Sermon</span><span role="columnheader">Last preached</span><span role="columnheader" class="hide-mobile">Index state</span><span role="columnheader" class="hide-sm">Versions</span><span role="columnheader">Action</span></div>'+
 items.map(s=>'<article class="workspace-row" role="row"><div role="cell"><h3><button data-c="detail" data-id="'+s.id+'">'+safe(s.title)+'</button></h3><span class="meta">'+safe(s.scripture||'No Scripture')+' · '+safe(s.series||'No series')+'</span>'+hitSnippet(s)+'</div><span class="meta" role="cell">'+format(lastDate(s))+'</span><span role="cell" class="hide-mobile">'+tag(idxStatus(s))+'</span><span class="meta hide-sm" role="cell">'+s.versions.length+'</span><span role="cell"><button class="btn" data-c="detail" data-id="'+s.id+'">Open</button></span></article>').join('')+'</div>';
};
renderContentOnly=function(){
 const el=$('content');
 if(state==='denied'){el.innerHTML=restricted('This workspace is not available to your account. No titles, counts or document excerpts are returned.')+'<button class="btn" data-c="reset-state">Try again</button>';return}
 if(state==='error'){el.innerHTML='<div class="alert error" role="alert"><b>Could not load the archive.</b> Your records are unchanged. Check your connection or try again; no partial success is shown.</div><button class="btn primary" data-c="reset-state">Retry loading</button>';return}
 if(state==='loading'){el.innerHTML='<section aria-busy="true" aria-label="Loading archive"><div class="skeleton short"></div><div class="skeleton med"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton med"></div></section>';return}
 if(page==='Archive'||page==='History'){
   const items=state==='empty'?[]:filtered();let output='';
   if(state==='revoked')output+='<div class="alert" role="status"><b>Google source access revoked.</b> The affected document is no longer searchable and its cached snippets would be purged. Other authorized records remain visible.</div>';
   output+=stats(items);
   output+='<div class="sectiontop"><div><h2>'+(page==='History'?'Preaching history':showArchived?'Archived sermons':'Sermon collection')+'</h2><p>'+items.length+' matching sermons · '+(showArchived?'archived records':'active records')+'</p></div><button class="btn" data-c="archive-toggle">'+(showArchived?'Show active':'View archived')+'</button></div>';
   output+=items.length?(page==='History'?timeline(items):workspace(items)):empty(state==='empty'?'This demonstrates a new, empty workspace.':'Try adjusting your search, year, or church filters.');
   el.innerHTML=output;return;
 }
 if(page==='Places'){
   const pls=state==='empty'?[]:totalPlaces();
   el.innerHTML='<div class="sectiontop"><h2>Manage churches and places</h2><p>'+pls.length+' places · one source of truth</p></div><p class="section-note">Renaming updates every preaching that uses that place. Merging requires reviewing affected records. Old names remain search aliases.</p>'+
   (pls.length?'<div class="subpage">'+pls.map((p,i)=>'<div class="subcard"><div><b>'+safe(p)+'</b><p>'+sermons.flatMap(s=>s.preached).filter(x=>x.place===p).length+' preaching occurrences</p></div><button class="btn" data-c="place" data-place-index="'+i+'" '+(!allowedEdit()?'disabled title="Viewer cannot edit places"':'')+'>Rename / merge</button></div>').join('')+'</div>':empty('Add a church as you log your first preaching.'));
   return;
 }
 const members=current().members;
 const permitted=allowedMembers();
 el.innerHTML='<div class="panel-grid">'+
 '<div class="subcard"><h3>People and access</h3><p>Viewers can read indexed text when the pastor has authorized sharing; original Google Drive permissions are separate.</p>'+
 members.map((m,i)=>'<div class="member"><span><b>'+safe(m.name)+'</b> · '+safe(m.role)+'</span>'+(m.role!=='Owner'&&permitted&&(role==='Owner'||m.role!=='Admin')?'<button class="btn" data-c="member" data-member="'+i+'">Manage</button>':'')+'</div>').join('')+
 '<button class="btn primary full-btn" data-c="invite" '+(!permitted?'disabled title="Only Owners and Admins may invite"':'')+'>Invite someone</button></div>'+
 '<div class="subcard"><h3>Document consent</h3><p>Google Docs remain in Drive. Owners must explicitly allow indexed text to be shared with workspace members.</p><button class="btn" data-c="consent">View consent and source status</button><p><small>No write scopes. Original PDF uploads are immutable.</small></p></div>'+
 '<div class="subcard"><h3>Workspaces</h3><p>Additional workspaces live here rather than cluttering the main archive.</p>'+
 Object.values(datasets).map(w=>'<div class="member"><span><b>'+safe(w.name)+'</b> · '+safe(w.role)+'</span><button class="btn" data-c="switch" data-workspace="'+w.id+'" '+(active===w.id?'disabled':'')+'>'+(active===w.id?'Current':'Switch')+'</button></div>').join('')+
 '</div>'+
 '<div class="subcard"><h3>Private import review</h3><p>Source originals remain unchanged; attribution, duplicates and uncertain locations require a documented review.</p><button class="btn" data-c="migration">Review '+importRows.filter(x=>x.status!=='Verified').length+' records</button></div>'+
 '<div class="subcard"><h3>Export and deletion</h3><p>Only Owners can initiate a complete archive export or permanently erase data. Editors can archive and restore.</p><button class="btn" data-c="export" '+(!allowedOwner()?'disabled':'')+'>Preview owner export</button></div>'+
 '<div class="subcard"><h3>Session and safety</h3><p>Prototype state is temporary and local. Permission checks must also be enforced at the server, index, download and membership boundaries.</p><button class="btn" data-c="reset">Reset all sample data</button></div>'+
 '</div>';
};
render=function(){
 nav();hero();renderFilters();$('searcharea').insertAdjacentHTML('beforeend',demoBar());
 $('searcharea').style.display=(page==='Archive'||page==='History')?'block':'block';
 renderContentOnly();
};
function openDetail(id){
 const s=getSermon(id);if(!s)return;
 let v=s.versions.map((x,i)=>'<div class="version"><b>'+safe(x.name)+' · '+safe(x.kind)+'</b><small>'+tag(x.status)+' · '+(x.kind==='Google Doc'?'Drive source stays unchanged':x.kind==='PDF'?'Original PDF bytes immutable':'External reference only')+'</small>'+(x.kind==='Google Doc'&&x.status==='Awaiting owner consent'&&allowedOwner()?'<button class="btn" data-c="consent-version" data-id="'+s.id+'" data-index="'+i+'">Review indexing consent</button>':'')+'</div>').join('');
 let h=s.preached.slice().sort((a,b)=>b.date.localeCompare(a.date)).map((p,i)=>'<div class="version"><b>'+format(p.date)+' — '+safe(p.place)+'</b><small>'+safe(p.occasion||'Preaching')+' · Version: '+safe(p.version||'Not specified')+'</small></div>').join('');
 dialog(safe(s.title),safe(s.scripture||'No Scripture')+' · '+safe(s.series||'No series'),
 '<div class="crumbs"><button data-c="close">← Back to library</button><span>/</span><span>One sermon, many preachings</span></div>'+help+
 '<div class="detail-split"><section class="detail-panel"><h3>Document versions</h3>'+(v||'<div class="placeholder">No versions yet. You can add a named reference without changing an original file.</div>')+
 '<button class="btn primary full-btn" data-c="version" data-id="'+s.id+'" '+(!allowedEdit()?'disabled':'')+'>+ Add version</button></section>'+
 '<section class="detail-panel"><h3>Preaching history ('+s.preached.length+')</h3>'+(h||'<div class="placeholder">No preaching occasions recorded yet.</div>')+
 '<button class="btn primary full-btn" data-c="preaching" data-id="'+s.id+'" '+(!allowedEdit()?'disabled':'')+'>+ Add preaching</button></section></div>'+
 '<div class="dialog-actions"><button class="btn" data-c="close">Done</button><button class="btn" data-c="edit" data-id="'+s.id+'" '+(!allowedEdit()?'disabled':'')+'>Edit metadata</button>'+
 (s.archived?'<button class="btn" data-c="restore" data-id="'+s.id+'" '+(!allowedEdit()?'disabled':'')+'>Restore</button>':'<button class="btn" data-c="archive" data-id="'+s.id+'" '+(!allowedEdit()?'disabled':'')+'>Archive</button>')+
 '<button class="btn danger" data-c="delete" data-id="'+s.id+'" '+(!allowedOwner()?'disabled title="Owner only"':'')+'>Permanently delete</button></div>');
}
function addForm(s){
 const edit=Boolean(s);
 const fields='<form id="phase-form" data-submit="'+(edit?'edit':'add')+'" class="fields">'+(edit?'<input type="hidden" name="id" value="'+s.id+'">':'')+
 input('title','Sermon title',s?.title||'','required maxlength="150"')+
 '<div class="form-row">'+input('scripture','Scripture reference',s?.scripture||'','maxlength="180"')+input('series','Series (optional)',s?.series||'','maxlength="120"')+'</div>'+
 input('tags','Tags, comma separated',(s?.tags||[]).join(', '),'maxlength="280"')+
 '<label class="form-field">Short description (archive metadata only)<textarea name="description" maxlength="900" placeholder="Optional note for your workspace">'+safe(s?.description||'')+'</textarea></label>'+
 help+formActions(edit?'Save metadata':'Create sermon')+'</form>';
 dialog(edit?'Edit sermon metadata':'Create a sermon',edit?'Original Google Docs and PDFs will not be edited.':'A title is enough to create a draft; versions and preachings can be added later.',fields);
}
function versionForm(id){
 const s=getSermon(id);if(!s||!allowedEdit())return;
 const body='<form id="phase-form" class="fields" data-submit="version"><input type="hidden" name="sermon" value="'+s.id+'">'+input('label','Version label','','required maxlength="120"')+
 '<label>Source type<select name="kind" id="source-kind"><option>Google Doc</option><option>PDF</option><option>External link</option></select></label>'+
 '<label>Google Docs or external HTTPS link<input name="url" type="url" placeholder="https://docs.google.com/document/d/..." autocomplete="off"><small>For PDFs, this is only an offline placeholder: no upload occurs in this demo.</small></label>'+
 '<label class="check-row"><input name="consent" type="checkbox" '+(!allowedOwner()?'disabled':'')+'><span>I am the workspace Owner and consent to the extracted Google Doc text being searchable by all current and future members of this workspace. Google permissions still govern the original document.</span></label>'+
 '<div class="alert">This prototype does not request Google scopes or upload PDF bytes. A saved source remains unindexed until an actual authorized backend validates it.</div>'+
 formActions('Add version reference')+'</form>';
 dialog('Add a document version',safe(s.title)+' · named reference only',body);
}
function preachingForm(id){
 if(!allowedEdit())return;
 const sorted=sermons.filter(s=>!s.archived);
 if(!sorted.length){announce('Create a sermon before logging a preaching.');return;}
 const preferred=getSermon(id)||sorted[0];
 let choices=sorted.map(s=>'<option value="'+s.id+'" '+(s.id===preferred.id?'selected':'')+'>'+safe(s.title)+'</option>').join('');
 const versionOptions=preferred.versions.map(v=>'<option value="'+safe(v.name)+'">'+safe(v.name)+'</option>').join('');
 dialog('Log another preaching','This adds a dated occasion to the selected sermon, never a duplicate master record.',
 '<form id="phase-form" data-submit="preaching" class="fields"><label>Existing sermon<select name="sermon" id="phase-sermon">'+choices+'</select></label>'+
 '<div class="form-row"><label>Date preached<input type="date" name="date" required value="2026-11-08"><small>Unknown date? Save a precision note for later verification.</small></label>'+
 '<label>Church / place<input name="place" list="phase-known-places" required placeholder="Search or enter venue"><datalist id="phase-known-places">'+totalPlaces().map(x=>'<option value="'+safe(x)+'"></option>').join('')+'</datalist></label></div>'+
 input('occasion','Event / occasion','Sunday Gathering','maxlength="160"')+
 '<label>Version used<select id="phase-version" name="version"><option value="">Not specified</option>'+versionOptions+'</select><small>Versions must be explicitly created; no document snapshots are generated.</small></label>'+
 input('note','Date or occasion note','','maxlength="200"')+
 formActions('Log preaching')+'</form>');
}
function placeForm(v){
 if(!allowedEdit())return;let count=v?sermons.flatMap(s=>s.preached).filter(p=>p.place===v).length:0;
 dialog(v?'Rename or merge a place':'Add a place','Places are workspace records. Confirm affected preachings before changing them.',
 '<form id="phase-form" data-submit="place" class="fields"><input type="hidden" name="old" value="'+safe(v||'')+'">'+
 '<div class="impact-count">'+count+' preaching records affected</div>'+input('name','New place name',v||'','required maxlength="150"')+
 (v?'<label>Merge into existing place (optional)<select name="merge"><option value="">Keep distinct / rename only</option>'+totalPlaces().filter(p=>p!==v).map(p=>'<option value="'+safe(p)+'">'+safe(p)+'</option>').join('')+'</select></label>':'')+
 (v?'<label class="check-row"><input type="checkbox" required name="confirmed"><span>I reviewed the impact on '+count+' preaching records. Keep the old name as a search alias.</span></label>':'')+
 '<div class="alert">Merge and rename are app metadata operations. Neither will change original source documents.</div>'+formActions(v?'Confirm place change':'Add place')+'</form>');
}
function inviteForm(){
 if(!allowedMembers())return;
 dialog('Invite someone','A new member can see indexed notes after the Owner has authorized indexed-text sharing.',
 '<form id="phase-form" data-submit="invite" class="fields"><label>Email<input type="email" name="email" placeholder="assistant@example.com" required></label><label>Role<select name="access">'+(allowedOwner()?'<option>Admin</option>':'')+'<option>Editor</option><option>Viewer</option></select></label>'+
 '<div class="alert">Owner: may delegate Admin. Admin: may invite or manage only Editors and Viewers. No email will actually be sent by this demo.</div>'+formActions('Preview invitation')+'</form>');
}
function memberForm(index){
 if(!allowedMembers())return;
 const m=current().members[index];
 if(!m||m.role==='Owner'||(!allowedOwner()&&m.role==='Admin')){announce('Only the Owner can change an Admin; the Owner account is protected.');return}
 dialog('Manage member',safe(m.name)+' · app access would be revoked immediately on removal.',
 '<form id="phase-form" data-submit="member" class="fields"><input name="index" type="hidden" value="'+index+'"><label>Role<select name="access">'+(allowedOwner()?'<option '+(m.role==='Admin'?'selected':'')+'>Admin</option>':'')+'<option '+(m.role==='Editor'?'selected':'')+'>Editor</option><option '+(m.role==='Viewer'?'selected':'')+'>Viewer</option></select></label>'+
 '<div class="alert">A role change does not change independent Google Drive permissions. Server authorization will be mandatory in the real app.</div>'+
 formActions('Save role')+'</form><div class="dialog-actions"><button class="btn danger" data-c="revoke" data-index="'+index+'">Revoke workspace access</button></div>');
}
function consentForm(id,index){
 if(!allowedOwner()){announce('Only the workspace Owner can authorize indexed-text sharing.');return}
 const s=getSermon(id),v=s?.versions[index];if(!v)return;
 dialog('Approve document indexing','Explicitly allow current and future workspace members to search extracted text.',
 '<div class="version"><b>'+safe(s.title)+' · '+safe(v.name)+'</b><small>Google Drive remains the source of truth. Access may be revoked at any time; derived indexes must then be purged.</small></div>'+
 '<form id="phase-form" data-submit="consent"><input name="sermon" type="hidden" value="'+s.id+'"><input name="index" type="hidden" value="'+index+'">'+
 '<label class="check-row"><input type="checkbox" required name="confirm"><span>As Owner, I authorize this specific Google Doc to be indexed and shared as searchable text with workspace members.</span></label>'+
 formActions('Approve consent')+'</form>');
}
function migrationList(){
 const body='<div class="alert"><b>Private staging only.</b> These are fictional placeholders, not the original sermon inventory. No imported record is owned by a pastor until attribution is verified.</div>'+
 '<div class="versions">'+importRows.map((r,i)=>'<div class="version"><b>'+safe(r.source)+' · '+safe(r.title)+'</b><small>'+safe(r.flags.join(', '))+' · '+safe(r.status)+'</small><button class="btn" data-c="review" data-index="'+i+'" '+(!allowedEdit()?'disabled':'')+'>Review record</button></div>').join('')+'</div><div class="dialog-actions"><button class="btn" data-c="close">Done</button></div>';
 dialog('Review historical import','Preserve source rows and evidence while resolving uncertainty.',body);
}
function reviewForm(i){
 const r=importRows[i];if(!r||!allowedEdit())return;
 const isOwner=allowedOwner();
 dialog('Review '+safe(r.source),safe(r.flags.join(' · ')),
 '<form id="phase-form" data-submit="review" class="fields"><input name="index" type="hidden" value="'+i+'">'+input('note','Reviewer notes',r.note,'maxlength="250"')+
 (isOwner?'<label class="check-row"><input name="verified" type="checkbox"><span>I checked original source attribution and verified which private workspace owns this record. Only after this verification may it be assigned.</span></label>':'<div class="alert">As an Editor, you may record review notes but cannot finalize ownership assignment in this demo.</div>')+
 help+formActions(isOwner?'Save verification':'Save review note')+'</form>');
}
function confirmation(kind,ids){
 let s=ids?.sermon?getSermon(ids.sermon):null;
 const titles={archive:'Archive sermon?',restore:'Restore sermon?',delete:'Permanently delete sermon?',revoke:'Revoke workspace access?'};
 const irreversible=kind==='delete';
 const impact=kind==='revoke'?'The person would immediately lose access to all records, previews and download links in this workspace.':irreversible?'This permanent deletion cannot be undone in the real service and must respect retention policies.':'This changes archive visibility, not the original sermon notes or documents.';
 let label=irreversible?'Type DELETE to confirm':'Confirm this change';
 let form='<form id="phase-form" data-submit="confirm" class="fields"><input type="hidden" name="kind" value="'+kind+'">'+
 (s?'<input type="hidden" name="sermon" value="'+s.id+'">':'')+(ids?.index!==undefined?'<input type="hidden" name="index" value="'+ids.index+'">':'')+
 (irreversible?input('word','Type DELETE','','required pattern="DELETE" placeholder="DELETE"'):'<label class="check-row"><input required name="confirmed" type="checkbox"><span>I understand the effect and confirm the action.</span></label>')+
 formActions(irreversible?'Permanently delete':'Confirm')+'</form>';
 dialog(titles[kind],safe(s?.title||current().members[ids?.index]?.name||'Workspace record'),'<div class="alert '+(irreversible?'error':'')+'">'+impact+'</div>'+form);
}
function permissions(){return '<div class="alert"><b>Read-only source guarantee:</b> Google Docs must be authorized file-by-file for read access only. Owners explicitly consent to indexing readable text for members. Original PDFs are never overwritten; replacement notes are a new version.</div><div class="versions">'+sermons.flatMap(s=>s.versions.filter(v=>v.kind==='Google Doc').map(v=>'<div class="version"><b>'+safe(s.title)+' · '+safe(v.name)+'</b><small>'+tag(v.status)+(v.status==='Revoked'?' — no searchable snippet':'')+'</small></div>')).join('')+'</div>'}
openDialog=function(kind,id){
 if(kind==='detail'){openDetail(Number(id));return}
 if(kind==='add'){if(allowedEdit())addForm();return}
 if(kind==='edit'){if(allowedEdit())addForm(getSermon(id));return}
 if(kind==='preaching'||kind==='repeat'){preachingForm(id);return}
 if(kind==='version'){versionForm(id);return}
 if(kind==='place'){placeForm(typeof id==='string'?id:'');return}
 if(kind==='invite'){inviteForm();return}
 if(kind==='migration'){migrationList();return}
 if(kind==='source'||kind==='consent'){dialog('Document access and consent','The original Google Doc can only be opened with separate Google Drive permission.',permissions());return}
};
function reset(){
 const seed=JSON.parse(JSON.stringify(data0)).map(s=>({...s,archived:false}));
 datasets.main.items=seed;datasets.main.members=[{name:'Pastor Morgan',role:'Owner'},{name:'Jo Reyes',role:'Editor'},{name:'Sam Quinn',role:'Viewer'}];
 datasets.guest.items=[];datasets.guest.members=[{name:'Pastor Riley',role:'Owner'},{name:'Pastor Morgan',role:'Editor'}];
 active='main';sermons=datasets.main.items;role='Owner';state='ready';showArchived=false;keyword='';placeFilter='';yearFilter='';customPlaces=[];aliases={};page='Archive';$('role').value='Owner';closeDialog();render();announce('Sample state reset. No real data was changed.');
}
function formSave(form){
 const d=new FormData(form),type=form.dataset.submit;
 if(!['confirm','member','invite'].includes(type)&&!allowedEdit()){announce('Not permitted for this role.');return}
 if(type==='add'){
   const title=String(d.get('title')||'').trim();if(!title)return;
   sermons.unshift({id:Math.max(0,...sermons.map(s=>s.id))+1,title,scripture:String(d.get('scripture')||'').trim(),series:String(d.get('series')||'').trim(),tags:String(d.get('tags')||'').split(',').map(x=>x.trim()).filter(Boolean),description:String(d.get('description')||'').trim(),excerpt:'',versions:[],preached:[],archived:false});
   closeDialog();render();announce('Demo draft created. No notes were modified.');return;
 }
 if(type==='edit'){
   const s=getSermon(d.get('id'));if(!s)return;
   for(const [field,value] of [['title',d.get('title')],['scripture',d.get('scripture')],['series',d.get('series')],['description',d.get('description')]])s[field]=String(value||'').trim();
   s.tags=String(d.get('tags')||'').split(',').map(x=>x.trim()).filter(Boolean);
   closeDialog();render();announce('Archive metadata updated. Originals unchanged.');return;
 }
 if(type==='version'){
   const s=getSermon(d.get('sermon'));if(!s)return;
   const label=String(d.get('label')||'').trim(),kind=String(d.get('kind')),url=String(d.get('url')||'').trim();
   if(s.versions.some(v=>v.name.toLowerCase()===label.toLowerCase())){announce('Give each version a distinct label.');return}
   if(kind!=='PDF'){
     let u;try{u=new URL(url)}catch(e){announce('Enter an HTTPS document link.');return}
     if(u.protocol!=='https:' || (kind==='Google Doc'&&!(u.hostname==='docs.google.com'&&u.pathname.startsWith('/document/d/')))){announce('Use a valid HTTPS link; Google Docs must use docs.google.com/document/d/.');return}
   }
   const consent=allowedOwner()&&d.get('consent')==='on';
   s.versions.push({name:label,kind,url,ownerConsent:consent,status:kind==='PDF'?'Pending upload':kind==='Google Doc'?(consent?'Awaiting indexing':'Awaiting owner consent'):'Link only'});
   closeDialog();render();announce('Version reference saved in demo; no file was uploaded or indexed.');return;
 }
 if(type==='preaching'){
   const s=getSermon(d.get('sermon'));if(!s)return;
   const place=String(d.get('place')||'').trim(),date=String(d.get('date')||'');
   if(!place||!date)return;
   const version=String(d.get('version')||'');
   if(version&&!s.versions.some(v=>v.name===version)){announce('Choose a version belonging to this sermon.');return}
   s.preached.push({date,place,occasion:String(d.get('occasion')||'').trim(),version:version||'Not specified',note:String(d.get('note')||'')});
   closeDialog();render();announce('Preaching recorded against the existing sermon.');return;
 }
 if(type==='place'){
   const old=String(d.get('old')||''),newName=String(d.get('merge')||d.get('name')||'').trim();
   if(!newName)return;
   if(old){
     if(!d.has('confirmed')){announce('Confirm the impacted preachings first.');return}
     for(const s of sermons)for(const p of s.preached)if(p.place===old)p.place=newName;
     aliases[newName]=uniq([...(aliases[newName]||[]),old,...(aliases[old]||[])]);
     delete aliases[old];customPlaces=customPlaces.map(p=>p===old?newName:p);
     if(placeFilter===old)placeFilter=newName;
   }else if(!customPlaces.includes(newName))customPlaces.push(newName);
   closeDialog();render();announce(old?'Place updated across the archive; source documents untouched.':'New place added to the directory.');return;
 }
 if(type==='invite'){
   if(!allowedMembers()){announce('Only Owner/Admin may invite.');return}
   const access=String(d.get('access')),email=String(d.get('email')||'').trim();
   if(access==='Admin'&&!allowedOwner()){announce('Only Owner may grant Admin.');return}
   if(current().members.some(x=>x.name.toLowerCase()===email.toLowerCase())){announce('Person already appears in the demo workspace.');return}
   current().members.push({name:email,role:access});closeDialog();render();announce('Invitation previewed. No email was sent.');return;
 }
 if(type==='member'){
   const i=Number(d.get('index')),m=current().members[i],next=String(d.get('access'));
   if(!allowedMembers()||!m||m.role==='Owner'||(!allowedOwner()&&(m.role==='Admin'||next==='Admin'))){announce('Role change blocked.');return}
   m.role=next;closeDialog();render();announce('Demo permission changed.');return;
 }
 if(type==='consent'){
   if(!allowedOwner()||!d.has('confirm')){announce('Owner consent is required.');return}
   const s=getSermon(d.get('sermon')),v=s?.versions[Number(d.get('index'))];if(!v||v.kind!=='Google Doc')return;
   v.ownerConsent=true;v.status='Awaiting indexing';closeDialog();render();announce('Owner consent recorded in demo; indexing has not actually run.');return;
 }
 if(type==='review'){
   const row=importRows[Number(d.get('index'))];if(!row)return;
   row.note=String(d.get('note')||'');
   if(allowedOwner()&&d.has('verified'))row.status='Verified';
   else row.status='Needs review';
   closeDialog();render();announce(row.status==='Verified'?'Fictional ownership verification recorded.':'Review note saved in demo.');return;
 }
 if(type==='confirm'){
   const kind=String(d.get('kind')),s=getSermon(d.get('sermon')),i=Number(d.get('index'));
   if(kind==='revoke'){
     const m=current().members[i];
     if(!allowedMembers()||!m||m.role==='Owner'||(!allowedOwner()&&m.role==='Admin'))return;
     current().members.splice(i,1);
   }else if(kind==='archive'||kind==='restore'){
     if(!allowedEdit()||!s)return;s.archived=kind==='archive';
   }else if(kind==='delete'){
     if(!allowedOwner()||!s||d.get('word')!=='DELETE')return;
     const p=sermons.findIndex(x=>x.id===s.id);if(p>=0)sermons.splice(p,1);
   }
   closeDialog();render();announce('Confirmed in memory. No live data changed.');return;
 }
}
document.addEventListener('click',event=>{
 const btn=event.target.closest('[data-c]');if(!btn||!root.contains(btn))return;
 const a=btn.dataset.c,id=btn.dataset.id,index=Number(btn.dataset.index);
 if(a==='close'){closeDialog();return}
 if(a==='clear'){resetFilters();return}
 if(a==='detail'){openDetail(id);return}
 if(a==='add'){openDialog('add');return}
 if(a==='edit'){openDialog('edit',id);return}
 if(a==='version'){openDialog('version',id);return}
 if(a==='preaching'){openDialog('preaching',id);return}
 if(a==='place'){const p=Number(btn.dataset.placeIndex);openDialog('place',Number.isFinite(p)&&btn.hasAttribute('data-place-index')?totalPlaces()[p]:'');return}
 if(a==='invite'){openDialog('invite');return}
 if(a==='member'){memberForm(Number(btn.dataset.member));return}
 if(a==='consent'){openDialog('consent');return}
 if(a==='consent-version'){consentForm(id,index);return}
 if(a==='migration'){migrationList();return}
 if(a==='review'){reviewForm(index);return}
 if(['archive','restore','delete'].includes(a)){if((a==='delete'&&!allowedOwner())||!allowedEdit())return;confirmation(a,{sermon:Number(id)});return}
 if(a==='revoke'){confirmation('revoke',{index});return}
 if(a==='archive-toggle'){showArchived=!showArchived;renderContentOnly();return}
 if(a==='reset'){reset();return}
 if(a==='reset-state'){state='ready';render();return}
 if(a==='switch'){
   const w=datasets[btn.dataset.workspace];if(!w)return;
   active=w.id;sermons=w.items;role=w.role;$('role').value=role;keyword='';yearFilter='';placeFilter='';showArchived=false;state='ready';page='Archive';render();announce('Switched to a distinct fictional workspace. No cross-workspace data shown.');return
 }
 if(a==='export'){
   if(!allowedOwner())return;
   dialog('Owner export (preview)','No files are generated by this demo; the real app will export sermon metadata and original stored uploads only.',
   '<div class="alert success">An eventual export will contain structured sermon/version/preaching records, place aliases and authorized stored PDF originals. Linked Google Docs are references, not duplicated content.</div><button class="btn" data-c="close">Close</button>');return;
 }
});
document.addEventListener('submit',e=>{
 const form=e.target.closest('form[data-submit]');if(!form||!root.contains(form))return;
 e.preventDefault();formSave(form);
});
document.addEventListener('change',e=>{
 if(e.target.id==='phase-state'){state=e.target.value;renderContentOnly();return}
 if(e.target.id==='phase-sermon'){
   const s=getSermon(e.target.value),sel=$('phase-version');
   if(sel)sel.innerHTML='<option value="">Not specified</option>'+(s?.versions||[]).map(v=>'<option value="'+safe(v.name)+'">'+safe(v.name)+'</option>').join('');
 }
});
document.addEventListener('keydown',e=>{
 if(!dialogOpen)return;
 if(e.key==='Tab'){
   const nodes=[...$('dialog').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')].filter(el=>el.offsetParent!==null);
   if(!nodes.length)return;
   const first=nodes[0],last=nodes.at(-1);
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
 }
});
render();
})();
