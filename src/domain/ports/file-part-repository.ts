import type { FilePart, NewFilePart } from '../entities/file-part';

/**
 * Repository interface for FilePart entity persistence.
 *
 * Abstracts the file-part operations currently in `src/db/file-parts.ts`.
 * File parts represent the chunks of a large file stored across multiple
 * Telegram messages for Telegram-safe storage.
 */
export interface IFilePartRepository {
  /**
   * Insert multiple file parts in a single operation.
   * @param parts - An array of new file part records (auto-generated fields omitted).
   */
  insert(parts: NewFilePart[]): Promise<void>;

  /**
   * List all file parts for a given file, ordered by part number.
   * @param fileId - The UUID of the parent file record.
   * @returns An array of file parts.
   */
  listByFileId(fileId: string): Promise<FilePart[]>;

  /**
   * Count the number of file parts associated with a file.
   * @param fileId - The UUID of the parent file record.
   * @returns The part count.
   */
  countByFileId(fileId: string): Promise<number>;
}
