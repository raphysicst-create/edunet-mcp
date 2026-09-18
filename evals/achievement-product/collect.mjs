import { createHash } from 'node:crypto';
import { achievementSearchResponseSchema, readAchievementResponseSchema } from '../../dist/achievement/contracts.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// References expire and contain signed provenance. Persist stable identities instead.
export function withoutReferences(value) {
  if (Array.isArray(value)) return value.map(withoutReferences);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['achievementRef', 'resourceRef', 'attachmentRef', 'cursor'].includes(key))
    .map(([key, item]) => [key, withoutReferences(item)]));
  return value;
}

async function call(client, name, input, schema) {
  const response = await client.callTool({ name, arguments: input }, undefined, { timeout: 50_000 });
  if (response.isError) throw new Error('tool_error');
  return schema.parse(response.structuredContent);
}

export async function collectQuery(query, { client, references }) {
  const start = performance.now();
  const observation = { id: query.id, input: { ...query.input, page: 1, pageSize: 20 }, candidates: [] };
  try {
    const data = await call(client, 'search_edunet_achievement', observation.input, achievementSearchResponseSchema);
    observation.status = data.status;
    observation.discoveryCoverage = data.coverage;
    observation.warnings = data.warnings;
    observation.pagination = data.pagination;
    observation.candidates = data.results.map(candidate => {
      const resource = references.verify(candidate.achievementRef, 'achievement').resource;
      return { ...withoutReferences(candidate), resourceId: resource.id };
    });
  } catch { observation.status = 'error'; observation.error = 'discovery_collection_failed'; }
  observation.durationMs = Math.round(performance.now() - start);
  return observation;
}

/** Drain the real MCP response, preserving duplicates for the scorer to penalize. */
export async function collectReadPages(first, next, { maxPages = 20 } = {}) {
  const result = { status: first.status, contentHash: first.source?.contentHash, records: [], rawBlocks: [],
    pages: [], complete: false, documentExtractionComplete: true, responsePagesComplete: false };
  const seenCursors = new Set(), seenPages = new Set();
  const identity = page => JSON.stringify([page.source?.contentHash, page.attachment?.parserName,
    page.attachment?.parserVersion, page.documentProfile?.profileId, page.documentProfile?.profileVersion]);
  const initialIdentity = identity(first);
  let data = first;
  for (let index = 0; index < maxPages; index++) {
    if (identity(data) !== initialIdentity) { result.error = 'document_or_parser_changed'; break; }
    const pageHash = digest([data.records, data.rawBlocks]);
    if (seenPages.has(pageHash)) { result.error = 'pagination_no_progress'; break; }
    seenPages.add(pageHash);
    result.pages.push({ status: data.status, recordCount: data.records.length, rawBlockCount: data.rawBlocks?.length ?? 0,
      documentExtractionComplete: data.documentExtractionComplete, responseTruncated: data.responseTruncated,
      hasMore: data.pagination?.hasMore, warnings: data.warnings });
    result.records.push(...data.records);
    result.rawBlocks.push(...(data.rawBlocks ?? []));
    result.documentExtractionComplete &&= data.documentExtractionComplete === true;
    if (!['verified_extraction', 'metadata_only', 'no_text'].includes(data.status) || !data.source?.contentHash) {
      result.error = 'document_read_failed'; break;
    }
    if (data.pagination?.hasMore === false && data.responseTruncated !== true) {
      result.responsePagesComplete = true;
      result.complete = result.documentExtractionComplete;
      if (!result.complete) result.error = 'document_extraction_incomplete';
      break;
    }
    const cursor = data.pagination?.cursor;
    if (!data.pagination?.hasMore || !cursor || seenCursors.has(cursor)) {
      result.error = 'pagination_missing_or_repeated_cursor'; break;
    }
    if (!data.records.length && !(data.rawBlocks ?? []).some(block => block.text.length)) {
      result.error = 'pagination_no_progress'; break;
    }
    seenCursors.add(cursor);
    if (index + 1 === maxPages) { result.error = 'read_page_limit'; break; }
    try { data = await next(cursor); }
    catch { result.error = 'read_page_failed'; break; }
  }
  return result;
}

export async function collectDocument(document, { client, references, maxPages = 20 }) {
  const start = performance.now();
  const observation = { id: document.id, status: 'error', records: [], complete: false,
    autoSelection: { action: 'error' }, attachments: [] };
  try {
    if (!document.resource?.id || !document.resource?.sourceUrl) throw new Error('missing_resource');
    const achievementRef = references.issue('achievement', { resource: document.resource });
    const read = args => call(client, 'read_edunet_achievement',
      { achievementRef, maxItems: 100, maxChars: 20000, ...args }, readAchievementResponseSchema);
    const first = await read({});
    const idOf = attachment => String(references.verify(attachment.attachmentRef, 'attachment').attachmentId);
    const selectedId = first.attachment ? idOf(first.attachment) : undefined;
    observation.autoSelection = selectedId ? { action: 'select', attachmentId: selectedId }
      : first.status === 'attachment_selection_required' ? { action: 'abstain' } : { action: 'error' };
    observation.autoSelection.status = first.status;
    const attachments = new Map();
    let listed = first;
    const seen = new Set();
    for (let page = 0; page < maxPages; page++) {
      const before = attachments.size;
      for (const item of listed.attachments ?? []) attachments.set(idOf(item), item);
      if (listed.status !== 'attachment_selection_required' || !listed.pagination?.hasMore) break;
      const cursor = listed.pagination.cursor;
      if (!cursor || seen.has(cursor) || before === attachments.size) throw new Error('attachment_pagination_stalled');
      seen.add(cursor);
      if (page + 1 === maxPages) throw new Error('attachment_page_limit');
      listed = await read({ cursor });
    }
    observation.attachments = [...attachments].map(([attachmentId, item]) => ({ attachmentId, ...withoutReferences(item) }));
    if (first.attachment) observation.attachments.push({ attachmentId: selectedId, ...withoutReferences(first.attachment) });
    if (!document.attachment?.id) {
      observation.status = first.status;
      observation.error = 'gold_attachment_not_selected';
      return observation;
    }
    const wantedId = String(document.attachment.id);
    const attachment = selectedId === wantedId ? first.attachment : attachments.get(wantedId);
    if (!attachment) throw new Error('gold_attachment_not_found');
    if (attachment.fileName !== document.attachment.fileName || attachment.format !== document.attachment.format) {
      observation.error = 'attachment_metadata_changed'; return observation;
    }
    const attachmentRef = attachment.attachmentRef;
    const initial = selectedId === wantedId ? first : await read({ attachmentRef });
    Object.assign(observation, await collectReadPages(initial, cursor => read({ attachmentRef, cursor }), { maxPages }));
    observation.attachment = { attachmentId: wantedId, ...withoutReferences(initial.attachment) };
    observation.documentProfile = initial.documentProfile;
  } catch { observation.error ??= 'document_collection_failed'; }
  finally { observation.durationMs = Math.round(performance.now() - start); }
  return observation;
}
