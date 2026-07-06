import { describe, expect, it } from 'bun:test';
import { contentRange, parseRangeHeader, unsatisfiedContentRange } from '../src/utils/s3/range';

describe('S3 HTTP range parser', () => {
  it('returns none when Range is missing', () => {
    expect(parseRangeHeader(null, 10)).toEqual({ type: 'none' });
  });

  it('parses explicit start/end ranges', () => {
    expect(parseRangeHeader('bytes=2-5', 10)).toEqual({ type: 'valid', start: 2, end: 5 });
  });

  it('clamps open-ended ranges to object size', () => {
    expect(parseRangeHeader('bytes=7-', 10)).toEqual({ type: 'valid', start: 7, end: 9 });
  });

  it('parses suffix ranges', () => {
    expect(parseRangeHeader('bytes=-4', 10)).toEqual({ type: 'valid', start: 6, end: 9 });
  });

  it('clamps oversized suffix ranges to the whole object', () => {
    expect(parseRangeHeader('bytes=-50', 10)).toEqual({ type: 'valid', start: 0, end: 9 });
  });

  it('rejects multiple ranges', () => {
    expect(parseRangeHeader('bytes=0-1,3-4', 10)).toEqual({ type: 'invalid' });
  });

  it('rejects unsatisfiable ranges', () => {
    expect(parseRangeHeader('bytes=10-12', 10)).toEqual({ type: 'invalid' });
    expect(parseRangeHeader('bytes=6-3', 10)).toEqual({ type: 'invalid' });
    expect(parseRangeHeader('bytes=-0', 10)).toEqual({ type: 'invalid' });
  });

  it('formats content-range headers', () => {
    expect(contentRange(2, 5, 10)).toBe('bytes 2-5/10');
    expect(unsatisfiedContentRange(10)).toBe('bytes */10');
  });
});
