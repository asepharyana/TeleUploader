export type RangeParseResult =
  | { type: 'none' }
  | { type: 'valid'; start: number; end: number }
  | { type: 'invalid' };

const DECIMAL = /^\d+$/;

export const parseRangeHeader = (rangeHeader: string | null, size: number): RangeParseResult => {
  if (!rangeHeader) return { type: 'none' };
  if (!Number.isSafeInteger(size) || size < 0) return { type: 'invalid' };
  if (!rangeHeader.startsWith('bytes=')) return { type: 'invalid' };

  const spec = rangeHeader.slice('bytes='.length).trim();
  if (spec.includes(',')) return { type: 'invalid' };

  const dash = spec.indexOf('-');
  if (dash === -1) return { type: 'invalid' };

  const startText = spec.slice(0, dash).trim();
  const endText = spec.slice(dash + 1).trim();
  if (!startText && !endText) return { type: 'invalid' };
  if (size === 0) return { type: 'invalid' };

  if (!startText) {
    if (!DECIMAL.test(endText)) return { type: 'invalid' };
    const suffixLength = Number.parseInt(endText, 10);
    if (suffixLength <= 0) return { type: 'invalid' };
    return { type: 'valid', start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  if (!DECIMAL.test(startText)) return { type: 'invalid' };
  const start = Number.parseInt(startText, 10);
  if (start >= size) return { type: 'invalid' };

  if (!endText) return { type: 'valid', start, end: size - 1 };
  if (!DECIMAL.test(endText)) return { type: 'invalid' };

  const requestedEnd = Number.parseInt(endText, 10);
  if (requestedEnd < start) return { type: 'invalid' };
  return { type: 'valid', start, end: Math.min(requestedEnd, size - 1) };
};

export const contentRange = (start: number, end: number, size: number): string =>
  `bytes ${start}-${end}/${size}`;

export const unsatisfiedContentRange = (size: number): string => `bytes */${size}`;
