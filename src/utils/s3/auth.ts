import { timingSafeEqual } from 'node:crypto';

/**
 * Timing-safe string comparison that prevents timing attacks.
 *
 * Uses `crypto.timingSafeEqual` which runs in constant time regardless of
 * where the strings differ. Returns false for mismatched-length inputs
 * to avoid leaking length information via early return.
 *
 * @param left - The first string to compare.
 * @param right - The second string to compare.
 * @returns True if both strings are equal.
 */
const timingSafeCompare = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
};

export interface SigV4Result {
  isValid: boolean;
  credential: {
    accessKey: string;
    date: string;
    region: string;
    service: string;
  } | null;
  errorCode?: string;
}

export interface VerifyPresignedUrlInput {
  url: string;
  method: string;
  headers: Record<string, string>;
  s3AccessKey: string;
  s3SecretKey: string;
  region: string;
  now?: Date;
}

const SERVICE = 's3';
const TERMINATION = 'aws4_request';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buf = (data: string | ArrayBuffer | Uint8Array): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new TextEncoder().encode(data);
};

const sha256Hex = async (data: string | Uint8Array | ArrayBuffer): Promise<string> => {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buf(data) as never);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

const hmacSha256 = async (key: Uint8Array, message: string): Promise<Uint8Array> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as never,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const result = await crypto.subtle.sign('HMAC', cryptoKey, buf(message) as never);
  return new Uint8Array(result);
};

const getSigningKey = async (
  secretKey: string,
  dateStamp: string,
  region: string,
): Promise<Uint8Array> => {
  let key = await hmacSha256(buf(`AWS4${secretKey}`), dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, SERVICE);
  return await hmacSha256(key, TERMINATION);
};

const hmacHex = async (key: Uint8Array, message: string): Promise<string> => {
  const result = await hmacSha256(key, message);
  return Array.from(result)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

const parseAuthorizationHeader = (authHeader: string) => {
  const credentialMatch = authHeader.match(/Credential=([^,]+)/);
  const signedHeadersMatch = authHeader.match(/SignedHeaders=([^,]+)/);
  const signatureMatch = authHeader.match(/Signature=([^,]+)/);

  if (!credentialMatch || !signedHeadersMatch || !signatureMatch) return null;

  const credentialParts = credentialMatch[1].split('/');
  if (credentialParts.length !== 5) return null;

  return {
    accessKey: credentialParts[0],
    date: credentialParts[1],
    region: credentialParts[2],
    service: credentialParts[3],
    termination: credentialParts[4],
    signedHeaders: signedHeadersMatch[1],
    signature: signatureMatch[1],
  };
};

const buildCanonicalRequest = (
  method: string,
  canonicalUri: string,
  canonicalQueryString: string,
  signedHeaders: string,
  headers: Record<string, string>,
  hashedPayload: string,
): string => {
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((h) => {
      const value = headers[h.toLowerCase()] || '';
      return `${h.toLowerCase()}:${value.trim()}\n`;
    })
    .join('');

  return `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
};

const normalizeUri = (uri: string): string => {
  if (!uri || uri === '') return '/';
  // AWS SigV4 requires URI-decoded paths in the canonical request
  return decodeURIComponent(uri);
};

const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export const buildCanonicalQueryString = (
  searchParams: URLSearchParams,
  excludeKeys: Set<string> = new Set(),
): string => {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    if (!excludeKeys.has(key)) pairs.push([key, value]);
  }
  pairs.sort(([ak, av], [bk, bv]) => {
    const a = `${awsEncode(ak)}=${awsEncode(av)}`;
    const b = `${awsEncode(bk)}=${awsEncode(bv)}`;
    return a.localeCompare(b);
  });
  return pairs.map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`).join('&');
};

const getHashedPayload = async (
  body: string | null,
  contentSha256: string | null,
): Promise<string> => {
  if (contentSha256) return contentSha256;
  if (!body || body.length === 0) return await sha256Hex('');
  return await sha256Hex(body);
};

export const verifySignature = async (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
  s3AccessKey: string,
  s3SecretKey: string,
  region: string,
): Promise<SigV4Result> => {
  const authHeader = headers.authorization;
  if (!authHeader?.startsWith('AWS4-HMAC-SHA256')) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }

  const parsed = parseAuthorizationHeader(authHeader);
  if (!parsed) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }

  if (!timingSafeCompare(parsed.accessKey, s3AccessKey)) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  if (!timingSafeCompare(parsed.region, region)) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  const parsedUrl = new URL(url, 'http://localhost');
  const canonicalUri = normalizeUri(parsedUrl.pathname);
  const canonicalQueryString = buildCanonicalQueryString(parsedUrl.searchParams);

  const contentSha256 = headers['x-amz-content-sha256'] || null;
  if (contentSha256?.startsWith('STREAMING-')) {
    return { isValid: false, credential: null, errorCode: 'NotImplemented' };
  }
  const hashedPayload = await getHashedPayload(body, contentSha256);

  const canonicalRequest = buildCanonicalRequest(
    method,
    canonicalUri,
    canonicalQueryString,
    parsed.signedHeaders,
    headers,
    hashedPayload,
  );

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);

  const amzDate = headers['x-amz-date'] || '';
  const dateStamp = parsed.date;
  const credentialScope = `${dateStamp}/${region}/${parsed.service}/${parsed.termination}`;

  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const signingKey = await getSigningKey(s3SecretKey, dateStamp, region);
  const expectedSignature = await hmacHex(signingKey, stringToSign);

  if (!timingSafeCompare(expectedSignature, parsed.signature)) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  return {
    isValid: true,
    credential: {
      accessKey: parsed.accessKey,
      date: parsed.date,
      region: parsed.region,
      service: parsed.service,
    },
  };
};

const parseAmzDateUtc = (amzDate: string): Date | null => {
  const match = amzDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
    ),
  );
};

export const verifyPresignedUrl = async ({
  url,
  method,
  headers,
  s3AccessKey,
  s3SecretKey,
  region,
  now = new Date(),
}: VerifyPresignedUrlInput): Promise<SigV4Result> => {
  const parsedUrl = new URL(url);
  const searchParams = parsedUrl.searchParams;

  const algorithm = searchParams.get('X-Amz-Algorithm');
  const credential = searchParams.get('X-Amz-Credential');
  const signedHeaders = searchParams.get('X-Amz-SignedHeaders');
  const signature = searchParams.get('X-Amz-Signature');
  const expiresText = searchParams.get('X-Amz-Expires');
  const amzDate = searchParams.get('X-Amz-Date');

  if (
    algorithm !== 'AWS4-HMAC-SHA256' ||
    !credential ||
    !signedHeaders ||
    !signature ||
    !expiresText ||
    !amzDate
  ) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }

  const expires = Number.parseInt(expiresText, 10);
  const signedAt = parseAmzDateUtc(amzDate);
  if (!Number.isFinite(expires) || expires <= 0 || !signedAt) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }
  // AWS S3 spec limits presigned URLs to 7 days (604800 seconds)
  const MAX_PRESIGNED_EXPIRY_SECONDS = 604800;
  if (
    now.getTime() > signedAt.getTime() + expires * 1000 ||
    expires > MAX_PRESIGNED_EXPIRY_SECONDS
  ) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }

  const credParts = credential.split('/');
  if (credParts.length !== 5) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }
  const [accessKey, dateStamp, credentialRegion, service, termination] = credParts;
  if (
    !timingSafeCompare(accessKey, s3AccessKey) ||
    !timingSafeCompare(credentialRegion, region) ||
    service !== SERVICE ||
    termination !== TERMINATION
  ) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  const signedHeaderList = signedHeaders.split(';').filter(Boolean);
  const canonicalHeaders = signedHeaderList
    .map((headerName) => {
      const lower = headerName.toLowerCase();
      const value = lower === 'host' ? headers.host || parsedUrl.host : headers[lower] || '';
      return `${lower}:${value.trim()}\n`;
    })
    .join('');

  const canonicalRequest = `${method}\n${normalizeUri(parsedUrl.pathname)}\n${buildCanonicalQueryString(searchParams, new Set(['X-Amz-Signature']))}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const credentialScope = `${dateStamp}/${region}/${SERVICE}/${TERMINATION}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;
  const expectedSignature = await hmacHex(
    await getSigningKey(s3SecretKey, dateStamp, region),
    stringToSign,
  );

  if (!timingSafeCompare(expectedSignature, signature)) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }
  return { isValid: true, credential: { accessKey, date: dateStamp, region, service } };
};

export const isS3Request = (headers: Record<string, string>): boolean => {
  const auth = headers.authorization || '';
  return auth.startsWith('AWS4-HMAC-SHA256');
};
