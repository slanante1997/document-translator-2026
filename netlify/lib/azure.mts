/**
 * Shared server-side helpers for the Netlify Functions.
 *
 * Nothing here may ever be imported by the Angular app: it reads the Azure
 * account key and the Translator subscription key, which must stay server-side.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BlobSASPermissions,
  ContainerSASPermissions,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';

export interface Env {
  translatorKey: string;
  translatorEndpoint: string;
  translatorRegion: string;
  accountName: string;
  accountKey: string;
  sourceContainer: string;
  targetContainer: string;
  signingSecret: string;
}

/** Document Translation REST API version this app is written against. */
export const API_VERSION = '2024-05-01';

/**
 * Formats the Document Translation service accepts. The upload endpoint
 * rejects anything else, so a stray SAS cannot be used to park arbitrary
 * payloads in the storage account.
 */
export const ALLOWED_EXTENSIONS = [
  // Office and OpenDocument
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.odp', '.ods', '.rtf',
  // Portable documents
  '.pdf',
  // Markup and web
  '.htm', '.html', '.mht', '.mhtml', '.dita', '.ditamap',
  // Markdown, in every spelling the service recognises
  '.md', '.markdown', '.mdown', '.mdtext', '.mdtxt', '.mdwn', '.mkd', '.mkdn', '.rmd',
  // Plain text and delimited
  '.txt', '.csv', '.tsv', '.tab',
  // Mail
  '.eml', '.msg',
  // Subtitles
  '.srt', '.vtt',
  // Localisation interchange
  '.xlf', '.xliff',
  // Images: translated via OCR
  '.bmp', '.jpg', '.jpeg', '.png', '.webp',
];

/** Hard ceiling mirroring the service limit, so we fail early and clearly. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;

let cached: Env | null = null;

/**
 * Reads and validates configuration. Throws a single message naming every
 * missing variable, because a half-configured deploy is the most common
 * first-run failure.
 */
export function readEnv(): Env {
  if (cached) return cached;

  const required = {
    AZURE_TRANSLATOR_KEY: process.env['AZURE_TRANSLATOR_KEY'],
    AZURE_TRANSLATOR_ENDPOINT: process.env['AZURE_TRANSLATOR_ENDPOINT'],
    AZURE_STORAGE_ACCOUNT_NAME: process.env['AZURE_STORAGE_ACCOUNT_NAME'],
    AZURE_STORAGE_ACCOUNT_KEY: process.env['AZURE_STORAGE_ACCOUNT_KEY'],
    AZURE_SOURCE_CONTAINER: process.env['AZURE_SOURCE_CONTAINER'],
    AZURE_TARGET_CONTAINER: process.env['AZURE_TARGET_CONTAINER'],
    SIGNING_SECRET: process.env['SIGNING_SECRET'],
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new ConfigError(
      `Missing environment variable(s): ${missing.join(', ')}. ` +
        'Set them in Netlify under Site configuration > Environment variables, ' +
        'or in a local .env file for `netlify dev`.'
    );
  }

  cached = {
    translatorKey: required.AZURE_TRANSLATOR_KEY!,
    translatorEndpoint: required.AZURE_TRANSLATOR_ENDPOINT!.replace(/\/+$/, ''),
    translatorRegion: process.env['AZURE_TRANSLATOR_REGION'] ?? '',
    accountName: required.AZURE_STORAGE_ACCOUNT_NAME!,
    accountKey: required.AZURE_STORAGE_ACCOUNT_KEY!,
    sourceContainer: required.AZURE_SOURCE_CONTAINER!,
    targetContainer: required.AZURE_TARGET_CONTAINER!,
    signingSecret: required.SIGNING_SECRET!,
  };
  return cached;
}

export class ConfigError extends Error {}

/** A client-visible failure with an HTTP status attached. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Blob naming and ownership tokens
// ---------------------------------------------------------------------------

/**
 * Builds the blob name for an upload. The name is always server-generated: the
 * client filename only contributes a validated extension, so a crafted name
 * cannot escape the container or collide with another document.
 */
export function newBlobName(originalName: string): string {
  const ext = extensionOf(originalName);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new HttpError(
      400,
      `Unsupported file type "${ext || originalName}". Supported: ${ALLOWED_EXTENSIONS.join(', ')}`
    );
  }
  return `${randomUUID()}${ext}`;
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

/**
 * Signs a blob name so later calls can prove they own it.
 *
 * Without this, `/api/download-url?blob=<guess>` would hand out read access to
 * any blob in the target container. The token is what makes a blob reference
 * unforgeable rather than merely hard to guess.
 */
export function signBlobName(blobName: string): string {
  const { signingSecret } = readEnv();
  return createHmac('sha256', signingSecret).update(blobName).digest('hex');
}

/** Constant-time token check that never reveals which part failed. */
export function assertToken(blobName: string, token: string | null | undefined): void {
  if (!token) throw new HttpError(403, 'Missing token.');
  const expected = Buffer.from(signBlobName(blobName), 'utf8');
  const given = Buffer.from(token, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new HttpError(403, 'Invalid token for this document.');
  }
}

/** Blob names we mint are always `<uuid><ext>`; reject anything else outright. */
export function assertWellFormedBlobName(blobName: string): void {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/;
  if (!pattern.test(blobName)) {
    throw new HttpError(400, 'Malformed document reference.');
  }
}

// ---------------------------------------------------------------------------
// SAS
// ---------------------------------------------------------------------------

/**
 * Mints a SAS URL scoped to one blob, one permission set and a short window.
 * HTTPS-only, so the signature cannot be replayed off a plaintext request.
 */
export function blobSasUrl(
  container: string,
  blobName: string,
  permissions: string,
  minutes: number,
  /** Optional response-header overrides, e.g. to force a download filename. */
  overrides: { contentDisposition?: string } = {}
): string {
  const env = readEnv();
  const credential = new StorageSharedKeyCredential(env.accountName, env.accountKey);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      blobName,
      permissions: BlobSASPermissions.parse(permissions),
      // Small backdate absorbs clock skew between Netlify and Azure.
      startsOn: new Date(Date.now() - 5 * 60_000),
      expiresOn: new Date(Date.now() + minutes * 60_000),
      protocol: SASProtocol.Https,
      ...(overrides.contentDisposition
        ? { contentDisposition: overrides.contentDisposition }
        : {}),
    },
    credential
  ).toString();

  const host = `https://${env.accountName}.blob.core.windows.net`;
  return `${host}/${container}/${encodeURIComponent(blobName)}?${sas}`;
}

/**
 * Mints a URL that points at one blob but carries a *container*-scoped SAS.
 *
 * Document Translation requires List on both sides (Read+List on the source,
 * Write+List on the target), and List has no meaning on a blob-scoped SAS - a
 * blob SAS makes the service fail with "Cannot access target document location
 * with the current permissions". A container SAS appended to a blob URL
 * satisfies it while still naming the exact file.
 *
 * These URLs are handed only to the Translator service, never to the browser.
 * The browser's upload and download URLs stay blob-scoped via `blobSasUrl`.
 */
export function containerScopedBlobUrl(
  container: string,
  blobName: string,
  permissions: string,
  minutes: number
): string {
  const env = readEnv();
  const credential = new StorageSharedKeyCredential(env.accountName, env.accountKey);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: container,
      // Omitting blobName is what makes this a container SAS (sr=c).
      permissions: ContainerSASPermissions.parse(permissions),
      startsOn: new Date(Date.now() - 5 * 60_000),
      expiresOn: new Date(Date.now() + minutes * 60_000),
      protocol: SASProtocol.Https,
    },
    credential
  ).toString();

  const host = `https://${env.accountName}.blob.core.windows.net`;
  return `${host}/${container}/${encodeURIComponent(blobName)}?${sas}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Wraps a handler so every failure becomes a JSON body the UI can show.
 * Unexpected errors are logged in full but reported generically, so Azure
 * responses never leak keys or internal URLs to the browser.
 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof ConfigError) {
      console.error('[config]', err.message);
      return json({ error: err.message }, 500);
    }
    console.error('[unhandled]', err);
    return json({ error: 'Unexpected server error. Check the function logs.' }, 500);
  }
}

/** Calls the Translator REST API with the subscription key attached. */
export async function translatorFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const env = readEnv();
  const headers: Record<string, string> = {
    'Ocp-Apim-Subscription-Key': env.translatorKey,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (env.translatorRegion) {
    headers['Ocp-Apim-Subscription-Region'] = env.translatorRegion;
  }
  return fetch(`${env.translatorEndpoint}${path}`, { ...init, headers });
}

/** Turns a non-2xx Translator response into a message worth showing a user. */
export async function translatorError(res: Response, fallback: string): Promise<never> {
  let detail = '';
  try {
    const body = (await res.clone().json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? '';
  } catch {
    detail = await res.text().catch(() => '');
  }
  console.error('[translator]', res.status, detail);

  // An auth failure is our misconfiguration, not the caller's: report it as 500
  // so the UI does not tell the visitor they are unauthorized.
  const status = res.status === 401 || res.status === 403 ? 500 : res.status;
  throw new HttpError(status, detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${res.status})`);
}
