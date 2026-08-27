import { describe, expect, it } from 'bun:test';
import {
  contentRange,
  parseRangeHeader,
  unsatisfiedContentRange,
} from '../src/interfaces/s3/range';

/**
 * S3 HTTP Range parser — comprehensive edge-case coverage.
 * Source: src/interfaces/s3/range.ts (the module that s3-controller and
 * object-stream actually use).
 */
describe('S3 HTTP range parser', () => {
  describe('no range', () => {
    it('returns none when Range header is null', () => {
      expect(parseRangeHeader(null, 10)).toEqual({ type: 'none' });
    });

    it('returns none when Range header is empty string', () => {
      expect(parseRangeHeader('', 10)).toEqual({ type: 'none' });
    });
  });

  describe('valid explicit ranges', () => {
    it('parses start/end', () => {
      expect(parseRangeHeader('bytes=2-5', 10)).toEqual({ type: 'valid', start: 2, end: 5 });
    });

    it('parses single-byte range', () => {
      expect(parseRangeHeader('bytes=3-3', 10)).toEqual({ type: 'valid', start: 3, end: 3 });
    });

    it('clamps end beyond object size', () => {
      expect(parseRangeHeader('bytes=7-20', 10)).toEqual({ type: 'valid', start: 7, end: 9 });
    });

    it('clamps end past last byte for open-ended range', () => {
      expect(parseRangeHeader('bytes=7-', 10)).toEqual({ type: 'valid', start: 7, end: 9 });
    });

    it('parses range starting at byte 0', () => {
      expect(parseRangeHeader('bytes=0-4', 10)).toEqual({ type: 'valid', start: 0, end: 4 });
    });

    it('uses last byte for open-ended range with no end', () => {
      expect(parseRangeHeader('bytes=9-', 10)).toEqual({ type: 'valid', start: 9, end: 9 });
    });
  });

  describe('suffix ranges (bytes=-N)', () => {
    it('returns last N bytes', () => {
      expect(parseRangeHeader('bytes=-4', 10)).toEqual({ type: 'valid', start: 6, end: 9 });
    });

    it('returns suffix of length equal to full object', () => {
      expect(parseRangeHeader('bytes=-10', 10)).toEqual({ type: 'valid', start: 0, end: 9 });
    });

    it('clamps oversized suffix to whole object', () => {
      expect(parseRangeHeader('bytes=-50', 10)).toEqual({ type: 'valid', start: 0, end: 9 });
    });

    it('returns last 1 byte', () => {
      expect(parseRangeHeader('bytes=-1', 10)).toEqual({ type: 'valid', start: 9, end: 9 });
    });
  });

  describe('invalid ranges', () => {
    it('rejects multiple comma-separated ranges', () => {
      expect(parseRangeHeader('bytes=0-1,3-4', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects non-bytes units', () => {
      expect(parseRangeHeader('items=0-1', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects start beyond last byte', () => {
      expect(parseRangeHeader('bytes=10-12', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects end before start', () => {
      expect(parseRangeHeader('bytes=6-3', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects zero-length suffix', () => {
      expect(parseRangeHeader('bytes=-0', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects non-numeric start', () => {
      expect(parseRangeHeader('bytes=aa-5', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects non-numeric end', () => {
      expect(parseRangeHeader('bytes=1-bb', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects empty both-sides range', () => {
      expect(parseRangeHeader('bytes=-', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects negative suffix length', () => {
      expect(parseRangeHeader('bytes=-3x', 10)).toEqual({ type: 'invalid' });
    });

    it('rejects range on zero-size object', () => {
      expect(parseRangeHeader('bytes=0-0', 0)).toEqual({ type: 'invalid' });
      expect(parseRangeHeader('bytes=-1', 0)).toEqual({ type: 'invalid' });
    });

    it('rejects invalid total size', () => {
      expect(parseRangeHeader('bytes=0-1', -1)).toEqual({ type: 'invalid' });
    });
  });

  describe('header formatting', () => {
    it('formats content-range', () => {
      expect(contentRange(0, 9, 10)).toBe('bytes 0-9/10');
      expect(contentRange(2, 5, 10)).toBe('bytes 2-5/10');
    });

    it('formats unsatisfied content-range', () => {
      expect(unsatisfiedContentRange(10)).toBe('bytes */10');
      expect(unsatisfiedContentRange(0)).toBe('bytes */0');
    });
  });
});
