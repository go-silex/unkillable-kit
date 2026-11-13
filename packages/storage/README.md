# `@kit/storage`

R2 helpers for Chemin A kit apps: safe keys, prefix-enforced client, light **PUT** presign.

## Surfaces

| Export                                        | Role                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `joinObjectKey` / `assertObjectKey`           | Path join; reject empty / `.` / `..` (no silent elision)                |
| `StorageClient`                               | Prefix-enforced put/get/delete/head/list/**presign** — **product path** |
| `StorageClient.presign(signer, { parts, … })` | Preferred product presign (prefix-safe key + sign)                      |
| `createPresignedUrl(signer, input)`           | Low-level: key **must** sit under required `prefix`                     |
| `createMockPresignSigner`                     | Local/CI mock (no CF account / secrets)                                 |

There are **no** free `putObject` / `getObject` / `deleteObject` helpers. Product object I/O
goes through `StorageClient` so keys stay under constructor `basePrefix`.
`createPresignedUrl` only checks that `key` sits under the **caller-supplied**
`prefix` (same-call consistency — not a tenant boundary). Pass `prefix` from app
config, not request input. Prefer `StorageClient.presign`.

## Streaming downloads

`get(parts)` returns an object or `null` when it is absent. Pass its `body`
directly to `Response` to stream the bytes without buffering them with `text()`;
`text()` remains available when the caller actually needs text. The optional
`httpMetadata.contentType` can populate the response's content type.

```ts
import { StorageClient, type KitR2Bucket } from '@kit/storage'

async function download(
  bucket: KitR2Bucket,
  parts: string[],
  authorize: (parts: string[]) => Promise<boolean>,
): Promise<Response> {
  const privateHeaders = { 'Cache-Control': 'private, no-store' }

  try {
    // The app authenticates the caller and authorizes this object before storage I/O.
    if (!(await authorize(parts))) {
      return new Response('Forbidden', { status: 403, headers: privateHeaders })
    }

    const object = await new StorageClient(bucket, 'demo').get(parts)
    if (!object) {
      return new Response('Not found', { status: 404, headers: privateHeaders })
    }

    const headers = new Headers(privateHeaders)
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream')
    return new Response(object.body, { headers })
  } catch {
    return new Response('Download failed', { status: 500, headers: privateHeaders })
  }
}
```

The app owns authentication and authorization, including how `parts` are
selected; prefix enforcement is not an access-control policy. The status codes
above are examples: map authorization, missing objects, and storage errors to
the app's HTTP contract without exposing internal details. Choose private cache
headers and any download behavior (such as a safe `Content-Disposition`
filename) at the app boundary. Streaming errors after the response has started
cannot be converted into a different HTTP status.

## Presign (kit v1)

- **Preferred path:** `client.presign(signer, { parts })` — builds the key under
  `basePrefix`, asserts prefix, then signs. Returns `{ url, method, headers?, expiresAt, key }`.
- **Advanced:** `createPresignedUrl(signer, { key, prefix, … })` — key must equal
  `prefix` or sit under `${prefix}/`. `prefix` is caller-declared (use a configured
  product root). Prefer `client.presign`.
- **PUT only** (A25 light helper — no video multipart).
- Package **never** holds R2 secrets — apps inject a `PresignSigner` (mock or future S3/aws4fetch).
- Example app: `PRESIGN_MODE=mock` (default) · `s3` **fail-closed** until a real signer is wired.

```ts
import { createMockPresignSigner, StorageClient } from '@kit/storage'

const client = new StorageClient(bucket, 'demo')
const signer = createMockPresignSigner()

// Preferred: prefix-safe parts → key + sign
const { url, headers, expiresAt, key } = await client.presign(signer, {
  parts: ['user', 'upload-id', 'file.bin'],
  expiresIn: 300,
  contentType: 'application/octet-stream',
})

// Advanced (full key + required prefix):
// import { createPresignedUrl } from '@kit/storage'
// await createPresignedUrl(signer, { key, prefix: 'demo', method: 'PUT', expiresIn: 300 })
```

Demo HTTP (auth required):

```bash
# after cookie session on $API (see root README Kit patterns B6)
curl -sS -b /tmp/kit-cj -c /tmp/kit-cj -X POST "$API/api/uploads/presign" \
  -H 'content-type: application/json' -H "Origin: $ORIGIN" \
  -d '{"filename":"file.bin","contentType":"application/octet-stream","size":1024}'

curl -sS -b /tmp/kit-cj -c /tmp/kit-cj -X POST "$API/api/uploads/<uploadId>/complete" \
  -H 'content-type: application/json' -H "Origin: $ORIGIN" \
  -d '{"key":"<key from presign>"}'
```

See `apps/example-api` routes `uploads` + tests `uploads.test.ts`.
