/**
 * Base domain error class for all application-specific errors.
 * Extends the built-in Error with a fixed name property for reliable
 * instance checking across layers.
 */
export class DomainError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DomainError';
  }
}

/**
 * Thrown when a requested file cannot be found in storage.
 */
export class FileNotFoundError extends DomainError {
  constructor(msg: string) {
    super(msg);
    this.name = 'FileNotFoundError';
  }
}

/**
 * Thrown when a requested bucket does not exist.
 */
export class BucketNotFoundError extends DomainError {
  constructor(msg: string) {
    super(msg);
    this.name = 'BucketNotFoundError';
  }
}

/**
 * Thrown when a file exceeds the maximum allowed size for upload.
 */
export class FileTooLargeError extends DomainError {
  constructor(msg: string) {
    super(msg);
    this.name = 'FileTooLargeError';
  }
}

/**
 * Thrown when an attempt is made to upload a file that already exists
 * (detected by content hash deduplication).
 */
export class DuplicateFileError extends DomainError {
  constructor(msg: string) {
    super(msg);
    this.name = 'DuplicateFileError';
  }
}

/**
 * Thrown when authentication fails or a valid session is not present.
 */
export class AuthenticationError extends DomainError {
  constructor(msg: string) {
    super(msg);
    this.name = 'AuthenticationError';
  }
}

/**
 * Thrown when input validation fails (e.g. missing required fields,
 * invalid format, or constraint violations).
 */
export class ValidationError extends DomainError {
  constructor(msg: string) {
    super(msg);
    this.name = 'ValidationError';
  }
}