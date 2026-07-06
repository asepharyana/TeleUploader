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

const buildCanonicalQueryString = (searchParams: URLSearchParams): string => {
  const params: string[] = [];
  const keys = Array.from(searchParams.keys()).sort();
  for (const key of keys) {
    const values = searchParams.getAll(key).sort();
    for (const value of values) {
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return params.join('&');
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

  if (parsed.accessKey !== s3AccessKey) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  if (parsed.region !== region) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  const parsedUrl = new URL(url, 'http://localhost');
  const canonicalUri = normalizeUri(parsedUrl.pathname);
  const canonicalQueryString = buildCanonicalQueryString(parsedUrl.searchParams);

  const contentSha256 = headers['x-amz-content-sha256'] || null;
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

  if (expectedSignature !== parsed.signature) {
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

export const verifyPresignedUrl = async (
  url: string,
  method: string,
  s3AccessKey: string,
  s3SecretKey: string,
  region: string,
): Promise<SigV4Result> => {
  const parsedUrl = new URL(url);
  const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());

  const algorithm = queryParams['X-Amz-Algorithm'];
  const credential = queryParams['X-Amz-Credential'];
  const signedHeaders = queryParams['X-Amz-SignedHeaders'];
  const signature = queryParams['X-Amz-Signature'];
  const expires = parseInt(queryParams['X-Amz-Expires'] || '0', 10);
  const amzDate = queryParams['X-Amz-Date'];

  if (
    !algorithm ||
    algorithm !== 'AWS4-HMAC-SHA256' ||
    !credential ||
    !signature ||
    !expires ||
    !amzDate
  ) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }

  // Check expiration
  const dateObj = new Date(
    parseInt(amzDate.substring(0, 4), 10),
    parseInt(amzDate.substring(4, 6), 10) - 1,
    parseInt(amzDate.substring(6, 8), 10),
    parseInt(amzDate.substring(9, 11), 10),
    parseInt(amzDate.substring(11, 13), 10),
    parseInt(amzDate.substring(13, 15), 10),
  );
  const expiresMs = expires * 1000;
  if (Date.now() > dateObj.getTime() + expiresMs) {
    return { isValid: false, credential: null, errorCode: 'AccessDenied' };
  }

  const credParts = credential.split('/');
  const presignedAccessKey = credParts[0];
  if (presignedAccessKey !== s3AccessKey) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }
  const dateStamp = credParts[1] || amzDate.substring(0, 8);

  const canonicalUri = normalizeUri(parsedUrl.pathname);

  const sortedParams = new URLSearchParams();
  const paramKeys = Object.keys(queryParams).sort();
  for (const key of paramKeys) {
    if (key !== 'X-Amz-Signature') {
      sortedParams.append(key, queryParams[key]);
    }
  }
  const canonicalQueryString = buildCanonicalQueryString(sortedParams);

  // Build canonical headers for presigned URL — only 'host' is typically signed
  const signedHeaderList = signedHeaders.split(';').filter(Boolean);
  const canonicalHeaders = signedHeaderList
    .map((h) => `${h.toLowerCase()}:${h === 'host' ? parsedUrl.host : ''}\n`)
    .join('');

  const hashedPayload = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashedCanonicalRequest}`;

  const signingKey = await getSigningKey(s3SecretKey, dateStamp, region);
  const expectedSignature = await hmacHex(signingKey, stringToSign);

  if (expectedSignature !== signature) {
    return { isValid: false, credential: null, errorCode: 'SignatureDoesNotMatch' };
  }

  return { isValid: true, credential: null };
};

export const isS3Request = (headers: Record<string, string>): boolean => {
  const auth = headers.authorization || '';
  return auth.startsWith('AWS4-HMAC-SHA256');
};
