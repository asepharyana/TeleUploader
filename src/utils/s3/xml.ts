const escapeXml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const isoDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ─────── Bucket operations ───────

export const listBucketsXml = (
  buckets: { name: string; createdAt: Date }[],
  _requestId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Buckets>
    ${buckets
      .map(
        (b) => `<Bucket>
      <Name>${escapeXml(b.name)}</Name>
      <CreationDate>${isoDate(b.createdAt)}</CreationDate>
    </Bucket>`,
      )
      .join('')}
  </Buckets>
</ListAllMyBucketsResult>`;

// ─────── Object listing ───────

export const listBucketResultXml = (
  bucketName: string,
  objects: { key: string; sizeBytes: number; etag: string; lastModified: Date; mimeType: string }[],
  prefixes: string[],
  isTruncated: boolean,
  marker: string | null,
  maxKeys: number,
  prefix: string,
  delimiter: string | null,
  nextMarker: string | null,
  _requestId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${escapeXml(prefix)}</Prefix>
  <Marker>${escapeXml(marker || '')}</Marker>
  <MaxKeys>${maxKeys}</MaxKeys>
  <Delimiter>${escapeXml(delimiter || '')}</Delimiter>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${objects
    .map(
      (o) => `<Contents>
    <Key>${escapeXml(o.key)}</Key>
    <LastModified>${isoDate(o.lastModified)}</LastModified>
    <ETag>"${o.etag}"</ETag>
    <Size>${o.sizeBytes}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
    )
    .join('')}
  ${prefixes
    .map(
      (p) => `<CommonPrefixes>
    <Prefix>${escapeXml(p)}</Prefix>
  </CommonPrefixes>`,
    )
    .join('')}
  ${nextMarker ? `<NextMarker>${escapeXml(nextMarker)}</NextMarker>` : ''}
</ListBucketResult>`;

export const listBucketV2ResultXml = (
  bucketName: string,
  objects: { key: string; sizeBytes: number; etag: string; lastModified: Date; mimeType: string }[],
  prefixes: string[],
  isTruncated: boolean,
  maxKeys: number,
  prefix: string,
  delimiter: string | null,
  continuationToken: string | null,
  nextContinuationToken: string | null,
  keyCount: number,
  _requestId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResultV2 xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${escapeXml(prefix)}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <KeyCount>${keyCount}</KeyCount>
  ${delimiter ? `<Delimiter>${escapeXml(delimiter)}</Delimiter>` : ''}
  ${continuationToken ? `<ContinuationToken>${escapeXml(continuationToken)}</ContinuationToken>` : ''}
  <IsTruncated>${isTruncated}</IsTruncated>
  ${objects
    .map(
      (o) => `<Contents>
    <Key>${escapeXml(o.key)}</Key>
    <LastModified>${isoDate(o.lastModified)}</LastModified>
    <ETag>"${o.etag}"</ETag>
    <Size>${o.sizeBytes}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`,
    )
    .join('')}
  ${prefixes
    .map(
      (p) => `<CommonPrefixes>
    <Prefix>${escapeXml(p)}</Prefix>
  </CommonPrefixes>`,
    )
    .join('')}
  ${nextContinuationToken ? `<NextContinuationToken>${escapeXml(nextContinuationToken)}</NextContinuationToken>` : ''}
</ListBucketResultV2>`;

// ─────── Multipart ───────

export const initiateMultipartUploadXml = (
  bucketName: string,
  key: string,
  uploadId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`;

export const listPartsXml = (
  bucketName: string,
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string; sizeBytes: number; createdAt: Date }[],
  maxParts: number,
  isTruncated: boolean,
  _requestId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <UploadId>${uploadId}</UploadId>
  <MaxParts>${maxParts}</MaxParts>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${parts
    .map(
      (p) => `<Part>
    <PartNumber>${p.partNumber}</PartNumber>
    <LastModified>${isoDate(p.createdAt)}</LastModified>
    <ETag>"${p.etag}"</ETag>
    <Size>${p.sizeBytes}</Size>
  </Part>`,
    )
    .join('')}
</ListPartsResult>`;

export const completeMultipartUploadXml = (
  bucketName: string,
  key: string,
  etag: string,
  location: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Location>${escapeXml(location)}</Location>
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <Key>${escapeXml(key)}</Key>
  <ETag>"${etag}"</ETag>
</CompleteMultipartUploadResult>`;

// ─────── Delete result ───────

export const deleteResultXml = (
  deleted: string[],
  errors: { key: string; code: string; message: string }[],
): string => `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  ${deleted
    .map(
      (key) => `<Deleted>
    <Key>${escapeXml(key)}</Key>
  </Deleted>`,
    )
    .join('')}
  ${errors
    .map(
      (e) => `<Error>
    <Key>${escapeXml(e.key)}</Key>
    <Code>${e.code}</Code>
    <Message>${escapeXml(e.message)}</Message>
  </Error>`,
    )
    .join('')}
</DeleteResult>`;

// ─────── Copy ───────

export const copyObjectResultXml = (
  etag: string,
  lastModified: Date,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <ETag>"${etag}"</ETag>
  <LastModified>${isoDate(lastModified)}</LastModified>
</CopyObjectResult>`;

// ─────── Error ───────

export const s3ErrorXml = (
  code: string,
  message: string,
  resource: string,
  requestId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>${code}</Code>
  <Message>${escapeXml(message)}</Message>
  <Resource>${escapeXml(resource)}</Resource>
  <RequestId>${requestId}</RequestId>
</Error>`;

export const s3ErrorResponse = (
  code: string,
  message: string,
  resource: string,
  status: number,
  requestId: string = '',
): Response =>
  new Response(s3ErrorXml(code, message, resource, requestId), {
    status,
    headers: {
      'content-type': 'application/xml',
      ...(requestId ? { 'x-amz-request-id': requestId } : {}),
    },
  });

// ─────── DeleteObjects XML parser ───────

export const parseDeleteObjectsBody = (body: string): { keys: string[]; quiet: boolean } => {
  const keys = Array.from(body.matchAll(/<Key>([^<]+)<\/Key>/g), (match) => match[1]);
  const quiet = body.includes('<Quiet>true</Quiet>') || body.includes('<Quiet>true ');
  return { keys, quiet };
};

// ─────── CompleteMultipartUpload XML parser ───────

export interface CompletePart {
  partNumber: number;
  etag: string;
}

export const parseCompleteMultipartBody = (body: string): CompletePart[] => {
  const parts: CompletePart[] = [];
  const partRegex = /<Part>[\s\S]*?<\/Part>/g;
  const partMatch = body.match(partRegex) || [];

  for (const partXml of partMatch) {
    const numMatch = partXml.match(/<PartNumber>(\d+)<\/PartNumber>/);
    const etagMatch = partXml.match(/<ETag>"?([^"<\s]+)"?<\/ETag>/);
    if (numMatch && etagMatch) {
      parts.push({
        partNumber: parseInt(numMatch[1], 10),
        etag: etagMatch[1].replace(/^"/, '').replace(/"$/, ''),
      });
    }
  }

  return parts;
};
