/**
 * GET /api/languages -> { languages: [{ code, name, nativeName, dir }] }
 *
 * Proxies Azure's public language list. That endpoint needs no subscription
 * key, but routing it through a function keeps the browser on one origin (no
 * CORS preflight) and lets us cache and normalise the payload.
 */
import type { Config } from '@netlify/functions';
import { HttpError, handle, json } from '../lib/azure.mts';

const LANGUAGES_URL =
  'https://api.cognitive.microsofttranslator.com/languages?api-version=3.0&scope=translation';

interface LanguagesResponse {
  translation?: Record<string, { name?: string; nativeName?: string; dir?: string }>;
}

export default async (): Promise<Response> =>
  handle(async () => {
    const res = await fetch(LANGUAGES_URL, { headers: { 'accept-language': 'en' } });
    if (!res.ok) {
      console.error('[languages]', res.status, await res.text().catch(() => ''));
      throw new HttpError(502, 'Could not load the language list from Azure.');
    }

    const body = (await res.json()) as LanguagesResponse;
    const languages = Object.entries(body.translation ?? {})
      .map(([code, meta]) => ({
        code,
        name: meta.name ?? code,
        nativeName: meta.nativeName ?? meta.name ?? code,
        dir: meta.dir ?? 'ltr',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!languages.length) throw new HttpError(502, 'Azure returned an empty language list.');

    return json({ languages }, 200, {
      // The list changes a few times a year; a day of CDN caching is plenty.
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    });
  });

export const config: Config = { path: '/api/languages' };
