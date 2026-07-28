import PQueue from 'p-queue';
import { config } from '../../env';
import logger from '../../shared/logger/index';

/**
 * P-queue instance for serialising Telegram upload tasks.
 *
 * Concurrency is governed by {@link config.uploadConcurrency}.
 * Built-in logging emits warnings when the queue grows beyond 5 pending items.
 */
const uploadQueue = new PQueue({
  concurrency: config.uploadConcurrency,
});

/* Monitor queue growth and emit warnings for large backlogs */
uploadQueue.on('add', () => {
  const stats = getQueueStats();
  if (stats.size > 5) {
    logger.warn('Upload queue building up', { pending: stats.pending, size: stats.size });
  }
});

uploadQueue.on('next', () => {
  const stats = getQueueStats();
  logger.debug('Processing next upload', { pending: stats.pending, size: stats.size });
});

/**
 * Enqueue an upload task to be executed by the queue.
 *
 * Tasks are executed in FIFO order, subject to the concurrency limit.
 *
 * @param task - An async function representing the upload operation.
 * @returns A promise that resolves with the task's result.
 */
export const enqueueUpload = <T>(task: () => Promise<T>): Promise<T> => {
  return uploadQueue.add(task);
};

/**
 * Get current queue statistics.
 *
 * @returns An object with `pending` (actively executing) and `size` (waiting) counts.
 */
export const getQueueStats = (): { pending: number; size: number } => ({
  pending: uploadQueue.pending,
  size: uploadQueue.size,
});

/**
 * Get the number of items waiting in the queue (not yet started).
 *
 * @returns The number of queued items.
 */
export const getQueueSize = (): number => uploadQueue.size;

/**
 * Get the number of items currently being processed.
 *
 * @returns The number of pending (in-flight) items.
 */
export const getPendingCount = (): number => uploadQueue.pending;

/**
 * Clear all pending items and wait for in-flight ones to finish.
 *
 * @returns A promise that resolves when the queue is idle after clearing.
 */
export const clearQueue = async (): Promise<void> => {
  uploadQueue.clear();
  await uploadQueue.onIdle();
};

/**
 * Wait for the queue to become idle (all tasks finished).
 *
 * @returns A promise that resolves when no tasks are pending or in-flight.
 */
export const waitForQueue = async (): Promise<void> => {
  await uploadQueue.onIdle();
};
