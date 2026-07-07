import { s3Headers } from './headers';

const escapeXml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const isoDate = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const encodeKey = (value: string, encodingType: string | null = null): string =>
  encodingType === 'url' ? encodeURIComponent(value) : escapeXml(value);

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

export const bucketVersioningConfigurationXml =
  (): string => `<?xml version="1.0" encoding="UTF-8"?>
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`;

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
  encodingType: string | null = null,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${encodeKey(prefix, encodingType)}</Prefix>
  <Marker>${encodeKey(marker || '', encodingType)}</Marker>
  <MaxKeys>${maxKeys}</MaxKeys>
  <Delimiter>${encodeKey(delimiter || '', encodingType)}</Delimiter>
  ${encodingType ? `<EncodingType>${escapeXml(encodingType)}</EncodingType>` : ''}
  <IsTruncated>${isTruncated}</IsTruncated>
  ${objects
    .map(
      (o) => `<Contents>
    <Key>${encodeKey(o.key, encodingType)}</Key>
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
    <Prefix>${encodeKey(p, encodingType)}</Prefix>
  </CommonPrefixes>`,
    )
    .join('')}
  ${nextMarker ? `<NextMarker>${encodeKey(nextMarker, encodingType)}</NextMarker>` : ''}
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
  encodingType: string | null = null,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResultV2 xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${encodeKey(prefix, encodingType)}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <KeyCount>${keyCount}</KeyCount>
  ${delimiter ? `<Delimiter>${encodeKey(delimiter, encodingType)}</Delimiter>` : ''}
  ${encodingType ? `<EncodingType>${escapeXml(encodingType)}</EncodingType>` : ''}
  ${continuationToken ? `<ContinuationToken>${encodeKey(continuationToken, encodingType)}</ContinuationToken>` : ''}
  <IsTruncated>${isTruncated}</IsTruncated>
  ${objects
    .map(
      (o) => `<Contents>
    <Key>${encodeKey(o.key, encodingType)}</Key>
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
    <Prefix>${encodeKey(p, encodingType)}</Prefix>
  </CommonPrefixes>`,
    )
    .join('')}
  ${nextContinuationToken ? `<NextContinuationToken>${encodeKey(nextContinuationToken, encodingType)}</NextContinuationToken>` : ''}
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

export const listMultipartUploadsXml = (
  bucketName: string,
  uploads: { key: string; uploadId: string; initiatedAt: Date; initiatedBy: string }[],
  maxUploads: number,
  isTruncated: boolean,
  nextKeyMarker: string | null,
  _requestId: string,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${escapeXml(bucketName)}</Bucket>
  <KeyMarker></KeyMarker>
  <UploadIdMarker></UploadIdMarker>
  ${nextKeyMarker ? `<NextKeyMarker>${escapeXml(nextKeyMarker)}</NextKeyMarker>` : ''}
  <MaxUploads>${maxUploads}</MaxUploads>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${uploads
    .map(
      (u) => `<Upload>
    <Key>${escapeXml(u.key)}</Key>
    <UploadId>${u.uploadId}</UploadId>
    <Initiator><ID>${escapeXml(u.initiatedBy || 's3')}</ID><DisplayName>${escapeXml(u.initiatedBy || 's3')}</DisplayName></Initiator>
    <Owner><ID>${escapeXml(u.initiatedBy || 's3')}</ID><DisplayName>${escapeXml(u.initiatedBy || 's3')}</DisplayName></Owner>
    <StorageClass>STANDARD</StorageClass>
    <Initiated>${isoDate(u.initiatedAt)}</Initiated>
  </Upload>`,
    )
    .join('')}
</ListMultipartUploadsResult>`;

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
  <HostId>${requestId}</HostId>
</Error>`;

export const s3ErrorResponse = (
  code: string,
  message: string,
  resource: string,
  status: number,
  requestId: string = '',
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(s3ErrorXml(code, message, resource, requestId), {
    status,
    headers: s3Headers(requestId, {
      'content-type': 'application/xml',
      ...extraHeaders,
    }),
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
