import { config } from '../../env';

const errorSchema = (example: string) => ({
  type: 'object',
  properties: {
    error: { type: 'string', example },
  },
});

const jsonContent = (schema: object) => ({
  'application/json': { schema },
});

const publicIdParameter = {
  name: 'public_id',
  in: 'path',
  required: true,
  description: 'Permanent public file ID.',
  schema: { type: 'string' },
};

const fileInfoProperties = {
  public_id: { type: 'string', example: 'xYz123' },
  file_name: { type: 'string', example: 'document.pdf' },
  mime_type: { type: 'string', example: 'application/pdf' },
  size_bytes: { type: 'integer', example: 1048576 },
  file_type: { type: 'string', example: 'document' },
  created_at: {
    type: 'string',
    format: 'date-time',
    example: '2026-05-18T10:00:00.000Z',
  },
};

const uploadProperties = {
  ...fileInfoProperties,
  download_url: {
    type: 'string',
    example: `${config.baseUrl}/f/xYz123`,
  },
};

const objectSchema = (properties: object) => ({
  type: 'object',
  properties,
});

export const handleSwaggerJson = async (): Promise<Response> => {
  const spec = {
    openapi: '3.0.0',
    info: {
      title: 'FileDrop API',
      version: config.appVersion,
      description:
        'File upload API with stream-based downloads, S3-compatible object storage, and admin auth.',
    },
    servers: [
      {
        url: '/',
        description: 'Current environment',
      },
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Health Check',
          description: 'Checks database connectivity status.',
          responses: {
            '200': {
              description: 'Database is healthy',
              content: jsonContent({
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'ok' },
                },
              }),
            },
            '500': {
              description: 'Database or server is unhealthy',
              content: jsonContent({
                type: 'object',
                properties: {
                  status: { type: 'string', example: 'error' },
                  error: { type: 'string', example: 'DB Connection Failed' },
                },
              }),
            },
          },
        },
      },
      '/api/upload': {
        post: {
          summary: 'Upload File',
          description:
            'Uploads a file to Telegram storage via multipart/form-data or JSON base64. Rate-limited by IP.',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'File binary payload.',
                    },
                    fileName: {
                      type: 'string',
                      description: 'Optional file name override.',
                    },
                  },
                },
              },
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: {
                      type: 'string',
                      description: 'Base64 encoded file content.',
                    },
                    fileName: {
                      type: 'string',
                      default: 'file',
                      description: 'Optional file name.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Successful upload metadata.',
              content: jsonContent(objectSchema(uploadProperties)),
            },
            '400': {
              description: 'Bad request.',
              content: jsonContent(errorSchema('No file provided')),
            },
            '413': {
              description: 'Request body too large.',
              content: jsonContent(errorSchema('Request body too large')),
            },
            '429': {
              description: 'Rate limit exceeded.',
              content: jsonContent(errorSchema('Rate limit exceeded')),
            },
            '500': {
              description: 'Internal server error.',
              content: jsonContent(errorSchema('Upload failed')),
            },
          },
        },
      },
      '/f/{public_id}': {
        get: {
          summary: 'Download File',
          description: 'Redirects to Telegram CDN for direct download. Rate-limited by IP.',
          parameters: [publicIdParameter],
          responses: {
            '302': {
              description: 'Redirect to Telegram CDN URL.',
            },
            '404': {
              description: 'File not found.',
              content: jsonContent(errorSchema('File not found')),
            },
            '429': {
              description: 'Rate limit exceeded.',
              content: jsonContent(errorSchema('Rate limit exceeded')),
            },
            '500': {
              description: 'Internal server error.',
              content: jsonContent(errorSchema('Server error')),
            },
          },
        },
      },
      '/file/{public_id}/info': {
        get: {
          summary: 'Get File Info',
          description: 'Gets saved file metadata by public ID.',
          parameters: [publicIdParameter],
          responses: {
            '200': {
              description: 'File metadata.',
              content: jsonContent(objectSchema(fileInfoProperties)),
            },
            '400': {
              description: 'Missing public ID.',
              content: jsonContent(errorSchema('Missing file id')),
            },
            '404': {
              description: 'File not found.',
              content: jsonContent(errorSchema('File not found')),
            },
            '500': {
              description: 'Internal server error.',
              content: jsonContent(errorSchema('Server error')),
            },
          },
        },
      },
      '/api/v1/auth/login': {
        post: {
          summary: 'Admin Login',
          description:
            'Validates the admin API token and sets a signed session cookie. Returns 404 when auth is disabled.',
          requestBody: {
            required: true,
            content: jsonContent(
              objectSchema({
                token: { type: 'string', example: 'admin-secret-token' },
              }),
            ),
          },
          responses: {
            '200': {
              description: 'Login successful; session cookie set.',
              content: jsonContent(
                objectSchema({
                  username: { type: 'string', example: 'admin' },
                }),
              ),
            },
            '400': {
              description: 'Token is required.',
              content: jsonContent(errorSchema('Token is required')),
            },
            '401': {
              description: 'Invalid token.',
              content: jsonContent(errorSchema('Invalid token')),
            },
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          summary: 'Admin Logout',
          description: 'Clears the session cookie.',
          responses: {
            '200': {
              description: 'Logout successful.',
              content: jsonContent(
                objectSchema({
                  success: { type: 'boolean', example: true },
                }),
              ),
            },
          },
        },
      },
      '/api/v1/auth/me': {
        get: {
          summary: 'Current User',
          description:
            'Returns the authenticated user from the session cookie or bearer token. Returns 404 when auth is disabled.',
          responses: {
            '200': {
              description: 'User info.',
              content: jsonContent(
                objectSchema({
                  username: { type: 'string', example: 'admin' },
                  expiresAt: {
                    type: 'string',
                    format: 'date-time',
                    nullable: true,
                    example: '2026-05-18T10:00:00.000Z',
                  },
                }),
              ),
            },
            '401': {
              description: 'Unauthorized.',
              content: jsonContent(errorSchema('Unauthorized')),
            },
          },
        },
      },
      '/api/v1/{path}': {
        get: {
          summary: 'Web API (read)',
          description:
            'Public read endpoints: list buckets/objects and download files. See the dashboard for the full reference.',
          responses: {
            '200': {
              description: 'Requested resource.',
            },
            '404': {
              description: 'Not found.',
              content: jsonContent(errorSchema('Not found')),
            },
          },
        },
      },
      '/{bucket}': {
        get: {
          summary: 'S3 Bucket Operations',
          description:
            'S3-compatible bucket endpoint (SigV4 auth). Supports ListObjects, versioning queries, and bucket management. Served without rate limiting so Docker registry pushes are not aborted by 429s.',
          parameters: [
            {
              name: 'bucket',
              in: 'path',
              required: true,
              description: 'Bucket name.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'S3 XML response.',
            },
            '403': {
              description: 'Signature mismatch.',
            },
          },
        },
      },
      '/{bucket}/{key}': {
        get: {
          summary: 'S3 Object Operations',
          description:
            'S3-compatible object endpoint (SigV4 auth): GetObject, PutObject, DeleteObject, and multipart uploads. Served without rate limiting so Docker registry pushes are not aborted by 429s.',
          parameters: [
            {
              name: 'bucket',
              in: 'path',
              required: true,
              description: 'Bucket name.',
              schema: { type: 'string' },
            },
            {
              name: 'key',
              in: 'path',
              required: true,
              description: 'Object key.',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'S3 XML or object bytes.',
            },
            '403': {
              description: 'Signature mismatch.',
            },
            '404': {
              description: 'NoSuchBucket / NoSuchKey.',
            },
          },
        },
      },
    },
  };

  return Response.json(spec, { status: 200 });
};

export const handleSwaggerHtml = async (): Promise<Response> => {
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>FileDrop API Documentation</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.css">
    <style>
      html { box-sizing: border-box; overflow-y: scroll; }
      *, *::before, *::after { box-sizing: inherit; }
      body { margin: 0; background: #fafafa; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function() {
        window.ui = SwaggerUIBundle({
          url: '/swagger.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          plugins: [SwaggerUIBundle.plugins.DownloadUrl],
          layout: 'BaseLayout'
        });
      };
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
};
