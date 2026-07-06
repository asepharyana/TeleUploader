import { describe, expect, it } from 'bun:test';

describe('S3 XML Builders', () => {
  it('builds ListBuckets XML', async () => {
    const xml = await import('../src/utils/s3/xml');
    const result = xml.listBucketsXml(
      [{ name: 'test-bucket', createdAt: new Date('2026-01-01T00:00:00Z') }],
      'req-1',
    );
    expect(result).toContain('<?xml');
    expect(result).toContain('<ListAllMyBucketsResult');
    expect(result).toContain('<Name>test-bucket</Name>');
    expect(result).toContain('<CreationDate>2026-01-01T00:00:00Z</CreationDate>');
  });

  it('builds escaped ListBucketResult XML', async () => {
    const xml = await import('../src/utils/s3/xml');
    const result = xml.listBucketResultXml(
      'my-bucket',
      [
        {
          key: 'folder/a&b.txt',
          sizeBytes: 100,
          etag: 'abc',
          lastModified: new Date('2026-01-01T00:00:00Z'),
          mimeType: 'text/plain',
        },
      ],
      ['photos/'],
      false,
      null,
      1000,
      '',
      '/',
      null,
      'req-1',
    );
    expect(result).toContain('<ListBucketResult');
    expect(result).toContain('<Key>folder/a&amp;b.txt</Key>');
    expect(result).toContain('<Size>100</Size>');
    expect(result).toContain('<Prefix>photos/</Prefix>');
  });

  it('builds ListBucketV2 XML', async () => {
    const xml = await import('../src/utils/s3/xml');
    const result = xml.listBucketV2ResultXml(
      'my-bucket',
      [
        {
          key: 'a.txt',
          sizeBytes: 50,
          etag: 'def',
          lastModified: new Date('2026-01-01T00:00:00Z'),
          mimeType: 'text/plain',
        },
      ],
      [],
      false,
      1000,
      '',
      null,
      null,
      null,
      1,
      'req-2',
    );
    expect(result).toContain('<ListBucketResultV2');
    expect(result).toContain('<KeyCount>1</KeyCount>');
    expect(result).toContain('<Key>a.txt</Key>');
  });

  it('builds multipart and copy XML responses', async () => {
    const xml = await import('../src/utils/s3/xml');
    expect(xml.initiateMultipartUploadXml('bucket', 'key', 'upload-123')).toContain(
      '<UploadId>upload-123</UploadId>',
    );
    expect(
      xml.completeMultipartUploadXml('bucket', 'key', 'etag-abc', 'http://localhost/bucket/key'),
    ).toContain('<CompleteMultipartUploadResult');
    expect(xml.copyObjectResultXml('etag-abc', new Date('2026-01-01T00:00:00Z'))).toContain(
      '<CopyObjectResult',
    );
  });

  it('builds error XML and error Response', async () => {
    const xml = await import('../src/utils/s3/xml');
    const result = xml.s3ErrorXml(
      'NoSuchBucket',
      'The specified bucket does not exist',
      '/bucket',
      'req-1',
    );
    expect(result).toContain('<Code>NoSuchBucket</Code>');
    expect(result).toContain('<RequestId>req-1</RequestId>');

    const res = xml.s3ErrorResponse('NoSuchBucket', 'Missing', '/bucket', 404, 'req-2');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-amz-request-id')).toBe('req-2');
  });

  it('parses DeleteObjects body', async () => {
    const xml = await import('../src/utils/s3/xml');
    const body =
      '<Delete><Object><Key>file1.txt</Key></Object><Object><Key>file2.txt</Key></Object><Quiet>true</Quiet></Delete>';
    const { keys, quiet } = xml.parseDeleteObjectsBody(body);
    expect(keys).toEqual(['file1.txt', 'file2.txt']);
    expect(quiet).toBe(true);
  });

  it('parses CompleteMultipartUpload body', async () => {
    const xml = await import('../src/utils/s3/xml');
    const body =
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"abc"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"def"</ETag></Part></CompleteMultipartUpload>';
    const parts = xml.parseCompleteMultipartBody(body);
    expect(parts).toEqual([
      { partNumber: 1, etag: 'abc' },
      { partNumber: 2, etag: 'def' },
    ]);
  });
});
