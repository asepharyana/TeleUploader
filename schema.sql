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