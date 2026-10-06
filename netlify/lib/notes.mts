/**
 * Server-side helpers for the synced notes scratchpad.
 *
 * The scratchpad is one JSON blob in its own container, kept apart from the
 * translation containers so a lifecycle rule that expires old documents can
 * never take the notes with it.
 */
import {
  BlobServiceClient,
  BlockBlobClient,
  ContainerClient,
  RestError,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { readEnv } from './azure.mts';

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
