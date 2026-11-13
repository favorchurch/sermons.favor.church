/**
 * PDF storage and text extraction primitives. No request or D1 access here. Nothing in this
 * file logs or returns document text except extractPdfText's return value.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { MAX_NOTE_CHARS } from '../search/index.ts';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type ExtractFailure = 'unreadable' | 'no_text' | 'text_too_large';

/** Content-addressed key. The workspace prefix keeps identical files in different workspaces apart. */
export const pdfKey = (workspaceId: string, sha256Hex: string): string => `workspaces/${workspaceId}/pdfs/${sha256Hex}.pdf`;

/** Where extracted text waits for Owner consent. Deleted once indexed or revoked. */
export const textKey = (workspaceId: string, versionId: string): string => `workspaces/${workspaceId}/extracted/${versionId}.txt`;

/** Read a request body, giving up (null) as soon as it passes `max` bytes. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > max)) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return bytes;
}

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
export const hasPdfMagic = (bytes: Uint8Array): boolean => MAGIC.every((byte, i) => bytes[i] === byte);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract the text of every page as one string, or report why that was not possible. The
 * result is all or nothing: a failure never yields partial text. Normalised like the index
 * input (NFC, LF line ends, trimmed), so what is stored is what will be indexed.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string } | { failure: ExtractFailure }> {
  let raw: string;
  try {
    // pdf.js may detach the buffer it is given, so hand it a copy.
    const document = await getDocumentProxy(bytes.slice());
    try {
      raw = (await extractText(document, { mergePages: true })).text;
    } finally {
      await document.destroy();
    }
  } catch {
    return { failure: 'unreadable' };
  }
  const text = raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) return { failure: 'no_text' };
  if (text.length > MAX_NOTE_CHARS) return { failure: 'text_too_large' };
  return { text };
}
