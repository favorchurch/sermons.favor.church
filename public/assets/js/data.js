// Workspace-scoped data access for the library UI. Everything goes through the same
// authenticated API the server enforces; the UI never trusts its own role checks.
const SERMON_PAGE = 100;
const EVENT_PAGE = 1000;
const MAX_PAGES = 60;

async function listAll(api, path, key, limit) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await api.get(`${path}${sep}limit=${limit}&offset=${page * limit}`);
    const batch = Array.isArray(data?.[key]) ? data[key] : [];
    items.push(...batch);
    if (batch.length < limit) break;
  }
  return items;
}

const unique = items => [...new Map(items.map(item => [item.id, item])).values()];

export function createLibraryClient(api, workspaceId) {
  const base = `/api/workspaces/${workspaceId}`;
  return {
    /** All sermons (archived included, so the archive toggle is instant) and all preaching events. */
    async loadLibrary() {
      const [sermons, events] = await Promise.all([
        listAll(api, `${base}/sermons?archived=include`, 'sermons', SERMON_PAGE),
        listAll(api, `${base}/events`, 'events', EVENT_PAGE)
      ]);
      return { sermons: unique(sermons), events: unique(events) };
    },
    getSermon: id => api.get(`${base}/sermons/${id}`),
    createSermon: title => api.post(`${base}/sermons`, { title }),
    updateSermon: (id, fields) => api.patch(`${base}/sermons/${id}`, fields),
    archiveSermon: id => api.post(`${base}/sermons/${id}/archive`),
    restoreSermon: id => api.post(`${base}/sermons/${id}/restore`),
    logPreaching: (id, fields) => api.post(`${base}/sermons/${id}/events`, fields),
    async listPlaces() { return (await api.get(`${base}/places`)).places || []; },
    createPlace: displayName => api.post(`${base}/places`, { display_name: displayName }),
    renamePlace: (id, displayName) => api.patch(`${base}/places/${id}`, { display_name: displayName }),
    previewMerge: (id, targetId) => api.get(`${base}/places/${id}/merge-preview?target=${encodeURIComponent(targetId)}`),
    mergePlaces: (id, targetId) => api.post(`${base}/places/${id}/merge`, { target_place_id: targetId }),

    search: (q, { archived = false } = {}) => api.get(`${base}/search?${new URLSearchParams({ q, archived: archived ? 'include' : 'exclude', limit: '50' })}`),
    findInNotes: (sermonId, q) => api.get(`${base}/sermons/${sermonId}/find-in-notes?${new URLSearchParams({ q })}`),

    async listMembers() { return (await api.get(`${base}/members`)).members || []; },
    invite: (email, role) => api.post(`${base}/invitations`, { email, role }),
    changeRole: (accountId, role) => api.patch(`${base}/members/${accountId}`, { role }),
    revokeMember: accountId => api.patch(`${base}/members/${accountId}`, { revoke: true }),

    createVersion: (sermonId, fields) => api.post(`${base}/sermons/${sermonId}/versions`, fields),
    uploadPdf: (sermonId, versionId, file) => api.postBinary(`${base}/sermons/${sermonId}/versions/${versionId}/pdf`, file, 'application/pdf'),
    consentToIndex: (sermonId, versionId) => api.post(`${base}/sermons/${sermonId}/versions/${versionId}/consent`),
    revokeIndexing: (sermonId, versionId) => api.post(`${base}/sermons/${sermonId}/versions/${versionId}/revoke`),
    pdfHref: (sermonId, versionId) => `${base}/sermons/${sermonId}/versions/${versionId}/pdf`,

    uploadImport: csv => api.post(`${base}/imports`, { csv }),
    importSummary: batchId => api.get(`${base}/imports/${batchId}/summary`),
    async importRows(batchId) { return (await api.get(`${base}/imports/${batchId}/rows`)).rows || []; },
    attestRows: (batchId, rowIds) => api.post(`${base}/imports/${batchId}/attest`, { row_ids: rowIds }),
    ignoreRow: (batchId, rowId) => api.post(`${base}/imports/${batchId}/rows/${rowId}/ignore`),
    approveRow: (batchId, rowId) => api.post(`${base}/imports/${batchId}/rows/${rowId}/approve`),
    rollbackRow: (batchId, rowId) => api.post(`${base}/imports/${batchId}/rows/${rowId}/rollback`)
  };
}
