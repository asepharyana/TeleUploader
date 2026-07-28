import { gunzipSync } from 'node:zlib';
import { applyS3Headers } from './headers';
import { contentRange, type RangeParseResult } from './range';

/** Timeout (ms) for individual Telegram CDN chunk fetches. */
const TELEGRAM_FETCH_TIMEOUT_MS = 30_000;

export interface ObjectPartSource {
  telegramFileId: string;
  telegramUrl: string;
  sizeBytes: number;
  partNumber: number;
  storedSizeBytes?: number;
  compressionAlgorithm?: 'gzip' | null;
}

export interface ObjectResponseInput {
  reqId: string;
  contentType: string;
  etag: string;
  lastModified: Date;
  totalSize: number;
  parts: ObjectPartSource[];
  range: RangeParseResult;
}

interface PlannedPart {
  part: ObjectPartSource;
  relativeStart: number;
  relativeEnd: number;
}

const baseHeaders = (input: ObjectResponseInput, contentLength: number): Headers => {
  const headers = new Headers({
    'content-type': input.contentType,
    'content-length': String(contentLength),
    etag: `"${input.etag}"`,
    'last-modified': input.lastModified.toUTCString(),
    'x-amz-request-id': input.reqId,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000',
  });
  return headers;
};

const planParts = (parts: ObjectPartSource[], start: number, end: number): PlannedPart[] => {
  const planned: PlannedPart[] = [];
  let offset = 0;
  for (const part of parts) {
    const partStart = offset;
    const partEnd = offset + part.sizeBytes - 1;
    offset += part.sizeBytes;
    if (end < partStart || start > partEnd) continue;
    planned.push({
      part,
      relativeStart: Math.max(start, partStart) - partStart,
      relativeEnd: Math.min(end, partEnd) - partStart,
    });
  }
  return planned;
};

const streamFromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Response(bytes).body!;

const fetchWholePartBytes = async (telegramUrl: string): Promise<Uint8Array> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(telegramUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`Telegram fetch failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
};

const fetchPartBody = async (planned: PlannedPart): Promise<ReadableStream<Uint8Array>> => {
  const wantsWholePart =
    planned.relativeStart === 0 && planned.relativeEnd === planned.part.sizeBytes - 1;

  if (planned.part.compressionAlgorithm === 'gzip') {
    const storedBytes = await fetchWholePartBytes(planned.part.telegramUrl);
    const bytes = gunzipSync(storedBytes);
    return streamFromBytes(bytes.subarray(planned.relativeStart, planned.relativeEnd + 1));
  }

  const rangeHeader = `bytes=${planned.relativeStart}-${planned.relativeEnd}`;
  const fetchOpts = wantsWholePart
    ? { signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS) }
    : { headers: { range: rangeHeader }, signal: AbortSignal.timeout(TELEGRAM_FETCH_TIMEOUT_MS) };
  const res = await fetch(planned.part.telegramUrl, fetchOpts);
  if (!res.ok) throw new Error(`Telegram fetch failed: ${res.status}`);
  if (wantsWholePart || res.status === 206) return res.body!;

  const bytes = new Uint8Array(await res.arrayBuffer());
  return streamFromBytes(bytes.slice(planned.relativeStart, planned.relativeEnd + 1));
};

const concatPartStreams = (plannedParts: PlannedPart[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const planned of plannedParts) {
          const stream = await fetchPartBody(planned);
          const reader = stream.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

export const createGetObjectResponse = async (input: ObjectResponseInput): Promise<Response> => {
  if (input.range.type === 'invalid') {
    throw new Error('createGetObjectResponse received invalid range');
  }

  const start = input.range.type === 'valid' ? input.range.start : 0;
  const end = input.range.type === 'valid' ? input.range.end : input.totalSize - 1;
  const plannedParts = planParts(input.parts, start, end);
  const contentLength = end >= start ? end - start + 1 : 0;
  const headers = applyS3Headers(baseHeaders(input, contentLength), input.reqId);

  if (input.range.type === 'valid') {
    headers.set('content-range', contentRange(start, end, input.totalSize));
  }

  return new Response(concatPartStreams(plannedParts), {
    status: input.range.type === 'valid' ? 206 : 200,
    headers,
  });
};
