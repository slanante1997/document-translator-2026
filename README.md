# Document Translator

An Angular app that translates documents with **Azure AI Translator**, preserving
the original layout and formatting. Hosted on Netlify, with Netlify Functions
acting as the server side so no Azure credential is ever shipped to the browser.

---

## How it works

```
Browser                    Netlify Functions              Azure
   │                              │                         │
   │  POST /api/upload-url        │                         │
   ├─────────────────────────────►│  mint write-only SAS    │
   │◄─────────────────────────────┤  (one blob, 30 min)     │
   │                              │                         │
   │  PUT <sasUrl>  ── file bytes go straight to Blob ──────►│  source container
   │                              │                         │
   │  POST /api/translate         │                         │
   ├─────────────────────────────►│  start batch job ──────►│  Translator
   │◄──────── jobId ──────────────┤                         │
   │                              │                         │
   │  GET /api/status  (poll)     │                         │
   ├─────────────────────────────►├────────────────────────►│
   │                              │                         │  target container
   │  GET /api/download-url       │                         │
   ├─────────────────────────────►│  mint read SAS (15 min) │
   │◄──────── downloadUrl ────────┤                         │
   │                                                        │
   │  GET <downloadUrl> ── translated file ─────────────────►│
```

The file never passes through a Netlify Function. That sidesteps the ~6 MB
function request-body limit and the 10 s execution timeout, so large documents
work normally.

### Why there is a backend at all

Anything bundled into an Angular app is public — `environment.ts` is not a
secret store. The Translator subscription key and the storage account key live
only in Netlify environment variables, read only by the functions in
[netlify/functions/](netlify/functions/).

### Why download links carry a token

`/api/download-url` mints a read SAS for a blob in the target container. Without
proof of ownership, anyone could ask it for someone else's document. Each blob
name is signed with an HMAC (`SIGNING_SECRET`) when it is created, and the
signature must be presented to start a translation or to download a result.

---

## Project layout

| Path | What it is |
| --- | --- |
| [src/app/app.component.ts](src/app/app.component.ts) | The whole UI: file selection, language pickers, progress, result |
| [src/app/translation.service.ts](src/app/translation.service.ts) | Drives the upload → translate → poll → download pipeline |
| [src/app/translation.models.ts](src/app/translation.models.ts) | Shared types, size and extension limits |
| [netlify/functions/](netlify/functions/) | The five API endpoints |
| [netlify/lib/azure.mts](netlify/lib/azure.mts) | SAS minting, HMAC tokens, env validation, error shaping |
| [netlify.toml](netlify.toml) | Build command, publish dir, SPA fallback, security headers |

---

## Azure setup

You already have the Translator resource and both containers. Two things still
need configuring.

### 1. CORS on the storage account

The browser uploads directly to Blob Storage, so the storage account must allow
it. In the Azure portal: **your storage account → Settings → Resource sharing
(CORS) → Blob service**, then add a rule:

| Field | Value |
| --- | --- |
| Allowed origins | `https://your-site.netlify.app` (add `http://localhost:4200` and `http://localhost:8888` for local dev) |
| Allowed methods | `PUT`, `GET`, `OPTIONS` |
| Allowed headers | `x-ms-blob-type, content-type` |
| Exposed headers | `*` |
| Max age | `3600` |

> If uploads fail with a network error and nothing appears in the function logs,
> this rule is the first thing to check — a missing CORS rule looks exactly like
> the storage account being unreachable.

### 2. Roles and keys

The functions authenticate with the **storage account key**, not a managed
identity — Netlify runs outside Azure, so managed identity is not available.
Copy it from **Storage account → Security + networking → Access keys**.

The Translator resource needs no extra role assignment for this flow: it reads
and writes using the SAS URLs the functions hand it.

---

## Environment variables

Copy [.env.example](.env.example) to `.env` for local development, and set the
same names in **Netlify → Site configuration → Environment variables** for the
deployed site.

| Variable | Notes |
| --- | --- |
| `AZURE_TRANSLATOR_KEY` | Translator resource → Keys and Endpoint |
| `AZURE_TRANSLATOR_ENDPOINT` | The **Document Translation** endpoint, e.g. `https://<resource>.cognitiveservices.azure.com` |
| `AZURE_TRANSLATOR_REGION` | Optional; required for multi-service or regional resources |
| `AZURE_STORAGE_ACCOUNT_NAME` | Storage account name |
| `AZURE_STORAGE_ACCOUNT_KEY` | Storage account access key |
| `AZURE_SOURCE_CONTAINER` | Container uploads land in |
| `AZURE_TARGET_CONTAINER` | Container Azure writes translations to |
| `SIGNING_SECRET` | Any long random string. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

`.env` is gitignored. Do not commit real keys.

---

## Running locally

A `.env` already exists with placeholder Azure values and a freshly generated
`SIGNING_SECRET`. Fill in the real Azure credentials and you are ready:

```bash
npm install
npm start                # http://localhost:8888 — UI *and* functions
```

`npm start` runs `netlify dev`, which serves the Angular dev server and the
functions together so `/api/*` resolves. Plain `ng serve` (`npm run start:ui`,
port 4200) runs the UI only, and every API call will 404.

> **Node version.** `netlify dev` loads `@netlify/angular-runtime`, which
> requires Node `^22.22.0 || ^24.13.1 || >=26`. This machine is on **22.11.0**,
> so `netlify dev` will refuse to start until Node is upgraded. Until then:
>
> ```bash
> npm run serve:functions   # functions alone on :9999, no version constraint
> npm run start:ui          # Angular dev server on :4200
> ```
>
> The deployed site is unaffected — `netlify.toml` pins the build image to
> `NODE_VERSION = "22.22.0"`.

---

## Deploying

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in Netlify: **Add new site → Import an existing project**, pick the repo,
and accept the settings from `netlify.toml`:

- Build command: `npm run build`
- Publish directory: `dist/document-translator-2026/browser`
- Functions directory: `netlify/functions`

Set the environment variables listed above **before** the first deploy, then
add the real site URL to the storage account's CORS origins.

---

## Limits

- **40 MB** per document, enforced client- and server-side. The service limit is
  higher for some formats; raise `MAX_FILE_BYTES` in both
  [translation.models.ts](src/app/translation.models.ts) and
  [netlify/lib/azure.mts](netlify/lib/azure.mts) if you need to.
- One document per job. The batch API supports many; the UI deliberately does not.
- Polling gives up after 15 minutes.

## Housekeeping

Nothing deletes old blobs. Both containers grow with every translation. Add a
[lifecycle management rule](https://learn.microsoft.com/azure/storage/blobs/lifecycle-management-overview)
on the storage account to expire blobs after a few days.
