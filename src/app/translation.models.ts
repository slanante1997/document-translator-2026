export interface Language {
  code: string;
  name: string;
  nativeName: string;
  dir: string;
}

/** Where a document is in the pipeline. Drives everything the UI renders. */
export type Phase =
  | 'idle'
  | 'preparing'
  | 'uploading'
  | 'starting'
  | 'translating'
  | 'done'
  | 'error';

export interface JobState {
  phase: Phase;
  /** 0-100 within the current phase; -1 when the phase has no measurable progress. */
  progress: number;
  message: string;
  downloadUrl?: string;
  charactersCharged?: number;
}

export interface UploadTicket {
  blobName: string;
  uploadUrl: string;
  token: string;
}

export interface StatusResponse {
  status: string;
  done: boolean;
  succeeded: boolean;
  progress: number;
  charactersCharged?: number;
  error?: string;
}

/** Mirrors the server-side allowlist so the picker and validation agree. */
export const ACCEPTED_EXTENSIONS = [
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
  '.txt', '.html', '.htm', '.md', '.markdown', '.csv', '.tsv',
  '.rtf', '.odt', '.odp', '.ods', '.msg', '.xlf', '.xliff',
];

export const MAX_FILE_BYTES = 40 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
