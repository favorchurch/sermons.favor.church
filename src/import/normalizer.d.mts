export type ImportRow = { id: string; source_tab: string; source_row: number; raw: string[]; proposed_date: string | null; proposed_title: string | null; proposed_place: string | null; flags: string[] };
export function inspectHistory(text: string, options?: { tab?: string }): { summary: { source_sha256: string }; rows: ImportRow[] };
export function titleKey(title: string | null | undefined): string;
