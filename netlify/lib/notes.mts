/**
 * Server-side helpers for the synced notes scratchpad.
 *
 * The scratchpad is one JSON blob in its own container, kept apart from the
 * translation containers so a lifecycle rule that expires old documents can
 * never take the notes with it.
 */
import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  BlobServiceClient,
  BlockBlobClient,
  ContainerClient,
  RestError,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { HttpError, readEnv } from './azure.mts';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/**
 * scrypt hash of the notes password. Only the hash is stored, and scrypt is
 * deliberately slow, so the password cannot practically be recovered from the
 * repository. To change it, generate a new pair with:
 *
 *   node -e "const c=require('crypto'),s=c.randomBytes(16);console.log(s.toString('hex'),c.scryptSync('NEW-PASSWORD',s,32).toString('hex'))"
 */
const PASSWORD_SALT = Buffer.from('3465358f2268ce4c8eaf73187b8eef23', 'hex');
const PASSWORD_HASH = Buffer.from(
  'beb602052739546124128ac25134a2adb597c92e6dbdbb4686129dea7b56e82f',
  'hex'
);

/** Slows password guessing; the right password never pays it. */
const WRONG_PASSWORD_DELAY_MS = 750;

/** The one blob the scratchpad lives in. */
export const NOTES_BLOB = 'scratchpad.json';

/**
 * Mirrors MAX_NOTES_BYTES in src/app/notes.service.ts. Pasted images are
 * embedded in the document, so this is mostly an image budget.
 */
export const MAX_NOTES_BYTES = 25 * 1024 * 1024;

export function notesContainer(): string {
  return process.env['AZURE_NOTES_CONTAINER'] || 'notes';
}

function notesContainerClient(): ContainerClient {
  const env = readEnv();
  const credential = new StorageSharedKeyCredential(env.accountName, env.accountKey);
  return new BlobServiceClient(
    `https://${env.accountName}.blob.core.windows.net`,
    credential
  ).getContainerClient(notesContainer());
}

function notesBlob(): BlockBlobClient {
  return notesContainerClient().getBlockBlobClient(NOTES_BLOB);
}

/**
 * Rejects any request that does not carry the notes password. This is what
 * actually protects the notes: the read and write SAS URLs are only ever
 * minted after it passes, and the container itself is private.
 *
 * The password arrives URI-encoded in a header (headers cannot carry
 * arbitrary Unicode), never in the URL, so it stays out of access logs.
 */
export async function assertNotesKey(req: Request): Promise<void> {
  let given = '';
  try {
    given = decodeURIComponent(req.headers.get('x-notes-key') ?? '');
  } catch {
    // Malformed encoding is just a wrong password.
  }

  const hash = given ? await scryptAsync(given, PASSWORD_SALT, PASSWORD_HASH.length) : null;
  if (!hash || !timingSafeEqual(hash, PASSWORD_HASH)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    throw new HttpError(401, 'Incorrect password.');
  }
}

/** ETag of the stored notes, or null if nothing has been saved yet. */
export async function currentNotesEtag(): Promise<string | null> {
  try {
    const props = await notesBlob().getProperties();
    return props.etag ?? null;
  } catch (err) {
    // Covers both a missing blob and a container that has not been created yet.
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

let containerReady = false;

/** Creates the notes container on first save, so there is no manual setup step. */
export async function ensureNotesContainer(): Promise<void> {
  if (containerReady) return;
  await notesContainerClient().createIfNotExists();
  containerReady = true;
}
