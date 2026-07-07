import { describe, expect, it } from 'bun:test';
import { handleSwaggerHtml, handleSwaggerJson } from '../src/routes/swagger';

describe('Swagger Documentation Endpoints', () => {
  it('returns OpenAPI specification JSON', async () => {
    const res = await handleSwaggerJson();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, { get?: object; post?: object }>;
    };
    expect(body.openapi).toBe('3.0.0');
    expect(body.info.title).toBe('FileDrop API');
    expect(body.paths).toHaveProperty('/health');
    expect(body.paths).toHaveProperty('/api/upload');
    expect(body.paths).toHaveProperty('/f/{public_id}');
    expect(body.paths).toHaveProperty('/file/{public_id}/info');

    const uploadPath = body.paths['/api/upload'] as any;
    const downloadPath = body.paths['/f/{public_id}'] as any;

    expect(uploadPath.post.requestBody.content).toHaveProperty('multipart/form-data');
    expect(uploadPath.post.requestBody.content).toHaveProperty('application/json');

    // Verify 429 response documented
    const uploadResponses = uploadPath.post.responses;
    expect(uploadResponses).toHaveProperty('429');

    // Verify download is 302 redirect to Telegram CDN
    const downloadResponses = downloadPath.get.responses;
    expect(downloadResponses).toHaveProperty('302');
    expect(downloadResponses['302'].description).toContain('Redirect');
  });

  it('returns Swagger UI HTML page', async () => {
    const res = await handleSwaggerHtml();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('swagger-ui');
    expect(html).toContain('/swagger.json');
    expect(html).toContain('swagger-ui-bundle.js');
  });

  it('should not expose CORS * header', async () => {
    const res = await handleSwaggerJson();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
