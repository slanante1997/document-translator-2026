/** Unwraps a function response, preferring the server's error text over a status code. */
export async function readJson<T>(res: Response, fallback: string): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${fallback} (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const message = (body as { error?: string })?.error;
    throw new Error(message || `${fallback} (HTTP ${res.status}).`);
  }
  return body as T;
}
