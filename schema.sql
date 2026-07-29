CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id VARCHAR(21) UNIQUE NOT NULL,
  telegram_file_id VARCHAR NOT NULL,
  telegram_file_unique_id VARCHAR NOT NULL,
  storage_chat_id BIGINT NOT NULL,
  storage_message_id BIGINT NOT NULL,
  file_name VARCHAR NOT NULL,
  mime_type VARCHAR NOT NULL,
  size_bytes BIGINT NOT NULL,
  file_type VARCHAR NOT NULL,
  uploader_id BIGINT NOT NULL,
  file_hash VARCHAR,
  archive_telegram_file_id VARCHAR,
  archive_storage_message_id BIGINT,
  archive_file_name VARCHAR,
  archive_entry_name VARCHAR,
  archive_mime_type VARCHAR,
  archive_size_bytes BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_files_public_id ON files(public_id);
CREATE INDEX IF NOT EXISTS idx_files_telegram_file_id ON files(telegram_file_id);
CREATE INDEX IF NOT EXISTS idx_files_file_hash ON files(file_hash);
CREATE INDEX IF NOT EXISTS idx_files_archive_telegram_file_id ON files(archive_telegram_file_id);
CREATE INDEX IF NOT EXISTS idx_files_uploader_id ON files(uploader_id);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);

-- S3-compatible buckets
CREATE TABLE IF NOT EXISTS buckets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(63) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Extend files table for S3
ALTER TABLE files ADD COLUMN IF NOT EXISTS bucket_id UUID REFERENCES buckets(id);
ALTER TABLE files ADD COLUMN IF NOT EXISTS s3_key TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS storage_backend VARCHAR DEFAULT 'telegram';
ALTER TABLE files ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT false;
ALTER TABLE files ADD COLUMN IF NOT EXISTS multipart_upload_id TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS part_count INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_bucket_key ON files(bucket_id, s3_key) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_files_bucket_prefix ON files(bucket_id, s3_key text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_files_s3_key ON files(s3_key);
CREATE INDEX IF NOT EXISTS idx_files_bucket_id ON files(bucket_id);

-- Multipart upload tracking
CREATE TABLE IF NOT EXISTS multipart_uploads (
  upload_id VARCHAR PRIMARY KEY,
  bucket_id UUID NOT NULL REFERENCES buckets(id),
  s3_key TEXT NOT NULL,
  initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR DEFAULT 'in_progress',
  initiated_by TEXT,
  content_type TEXT
);

CREATE TABLE IF NOT EXISTS multipart_parts (
  id SERIAL PRIMARY KEY,
  upload_id VARCHAR NOT NULL REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE,
  part_number INT NOT NULL,
  telegram_file_id VARCHAR NOT NULL,
  telegram_file_unique_id VARCHAR NOT NULL,
  storage_message_id BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  etag VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(upload_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_multipart_parts_upload ON multipart_parts(upload_id, part_number);
CREATE INDEX IF NOT EXISTS idx_multipart_uploads_status ON multipart_uploads(status);

-- Permanent internal chunks for Telegram-safe storage.
-- This is separate from S3 multipart protocol state above.
CREATE TABLE IF NOT EXISTS file_parts (
  id SERIAL PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_number INT NOT NULL,
  telegram_file_id VARCHAR NOT NULL,
  telegram_file_unique_id VARCHAR NOT NULL,
  storage_chat_id BIGINT NOT NULL,
  storage_message_id BIGINT NOT NULL,
  size_bytes BIGINT NOT NULL,
  stored_size_bytes BIGINT NOT NULL,
  compression_algorithm VARCHAR,
  etag VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_file_parts_file_id ON file_parts(file_id, part_number);