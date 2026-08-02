# S3 Compatibility Completion Design

> Catatan (2026-08-02): Produksi sekarang port 4000, deploy Nix+systemd di orangevps, Caddy reverse proxy upload.asepharyana.my.id, DB via pgbouncer pool imrnes 100.121.180.82:6432. Docker/Traefik/Gitea-CI legacy.

Date: 2026-07-07

## Goal

Close the remaining known S3 compatibility gaps in TeleUploader while preserving strict SigV4 security. The target is real-client compatibility for common S3 flows against the production endpoint, especially AWS SDK v3, without accepting malformed or unverifiable signatures.

## Scope

Implement and verify:

1. Presigned `GET` URLs return object content instead of `403 SignatureDoesNotMatch`.
2. `GetObject` supports `Range: bytes=...` for single-part objects.
3. Multipart `GetObject` returns the complete logical object, not just the first Telegram part.
4. Multipart `GetObject` supports byte ranges across part boundaries.
5. AWS SDK multipart upload is investigated and fixed under strict SigV4 if the mismatch is in TeleUploader canonicalization/routing.
6. The remaining CSS lint warning in `src/home.html` is removed.

Out of scope:

- Weakening SigV4 verification to accept invalid signatures.
- Full AWS S3 feature parity for ACLs, bucket policy, object tags, virtual-hosted-style routing, or checksum-specific APIs.
- Replacing Telegram storage with a different backend.

## Design Choice

Use a **strict compatibility, shared object streaming layer**.

Rather than adding one-off fixes inside `handleGetObject`, introduce small helpers with clear responsibilities:

- request authentication remains strict and spec-based;
- object lookup returns object metadata and an ordered list of physical Telegram parts;
- range parsing converts a `Range` header into byte offsets;
- response streaming emits either a full body (`200`) or a partial body (`206`) with correct S3/HTTP headers.

This keeps S3 auth, object resolution, byte planning, and streaming separately testable.

## Presigned URL Verification

Current behavior builds a URL with `http://localhost/...`, which can produce a host mismatch for presigned signatures generated against the public production host.

New behavior:

- pass the original request URL and headers into presigned verification;
- compute canonical URI from the actual URL path;
- compute canonical query string by excluding `X-Amz-Signature`, sorting encoded key/value pairs, and preserving AWS SigV4 encoding rules;
- validate credential scope parts: access key, date, region, service `s3`, termination `aws4_request`;
- use the signed `host` header value when present, otherwise the request URL host;
- parse `X-Amz-Date` as UTC and enforce `X-Amz-Expires`.

Production E2E must change from accepting `[200, 302, 403]` to requiring `200` and body content for presigned `GET` when `PROXY_S3_GET` is enabled.

## Object Body Model

Represent the physical body as ordered parts:

```ts
interface ObjectPartSource {
  telegramFileId: string;
  sizeBytes: number;
  partNumber: number;
}
```

Single-part objects produce one source from the `files` row.
Multipart objects produce sources from `multipart_parts` ordered by `part_number`.

The logical object size is:

- `file.sizeBytes` for single-part;
- sum of part sizes for multipart, cross-checked against `file.sizeBytes` when available.

## Range Handling

Support single-range requests only:

- `bytes=0-4`
- `bytes=5-`
- `bytes=-500`

Invalid or unsatisfiable ranges return `416` with `Content-Range: bytes */<size>`.
Multiple ranges such as `bytes=0-1,3-4` are not supported and return `416`.

For a valid range:

- return status `206`;
- set `Content-Range: bytes <start>-<end>/<size>`;
- set `Content-Length` to `end - start + 1`;
- keep `Accept-Ranges: bytes`.

## Telegram Streaming

For each needed part:

1. Call `getFileInfo(telegramFileId)`.
2. Build the Telegram CDN URL.
3. Fetch only the needed range when possible using a `Range` request to Telegram.
4. If Telegram returns `206`, stream that response body.
5. If Telegram returns `200` for a partial request, slice the response in TeleUploader for correctness.
6. If Telegram fetch fails, return S3 XML `InternalError` with HTTP `502`.

Multipart full-object responses concatenate part streams in order with a `ReadableStream`.
Multipart range responses calculate part overlap using cumulative byte offsets and only stream overlapped segments.

## AWS SDK Multipart Upload

Add a real AWS SDK multipart test path using:

- `CreateMultipartUploadCommand`
- `UploadPartCommand`
- `CompleteMultipartUploadCommand`
- `GetObjectCommand`
- cleanup via `AbortMultipartUploadCommand` on failure

Keep SigV4 strict. If the SDK multipart signature still fails:

1. capture server-side canonical request components in a temporary diagnostic path or test-only log;
2. compare against the SDK request inputs;
3. fix TeleUploader canonicalization if wrong;
4. if the mismatch is caused by upstream proxy/header mutation outside the app, leave strict behavior intact and document the blocker with evidence.

No compatibility fallback is allowed in this pass.

## CSS Lint Warning

Remove `noDescendingSpecificity` by reordering the `.modal input` rule before the more specific `.topbar .search input` rule, or by making selector ordering explicitly non-conflicting. No visual redesign is required.

## Tests and Verification

Unit tests:

- presigned URL canonicalization and expiration edge cases;
- range parser valid/invalid forms;
- multipart range planning across part boundaries.

Production E2E:

- presigned `GET` returns `200` and expected body;
- single-part range returns `206` and expected substring;
- multipart upload via manual signer returns complete body;
- multipart range returns expected cross-part substring;
- invalid range returns `416`.

AWS SDK E2E:

- existing SDK suite remains passing;
- `GetObjectCommand({ Range: 'bytes=...' })` verifies partial body;
- real SDK multipart is enabled if strict SigV4 succeeds after canonicalization fixes.

Deploy verification:

- `bun run lint` has no errors and no warnings;
- targeted unit tests pass;
- production E2E passes;
- AWS SDK E2E passes;
- `./deploy.sh` completes and container is healthy;
- post-deploy production E2E and SDK E2E pass.

## Error Handling

- Authentication failures return S3 XML errors with `403`.
- Missing bucket/key behavior is unchanged.
- Telegram fetch failures return S3 XML `InternalError` with `502`.
- Invalid ranges return `InvalidRange` XML with `416`.
- Multipart objects with no parts return `InternalError`.

## Rollout

The existing `PROXY_S3_GET` flag remains:

- default `true`: S3-compatible streaming responses;
- `false`: legacy redirect path for single-part objects only.

Multipart complete-body support requires proxy mode. If proxy mode is disabled and a multipart object is requested, the response may fall back to the first-part redirect only as legacy behavior; production compatibility should keep proxy mode enabled.
