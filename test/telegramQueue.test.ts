import { describe, expect, it } from 'bun:test';
import { enqueueUpload } from '../src/infrastructure/telegram/upload-queue';

describe('Telegram Queue', () => {
  it('should process tasks in parallel without limit', async () => {
    let activeTasks = 0;
    let maxActiveTasks = 0;

    const createTask = (id: number, delayMs: number) => {
      return async () => {
        activeTasks++;
        if (activeTasks > maxActiveTasks) {
          maxActiveTasks = activeTasks;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        activeTasks--;
        return id;
      };
    };

    const promises = [
      enqueueUpload(createTask(1, 50)),
      enqueueUpload(createTask(2, 50)),
      enqueueUpload(createTask(3, 50)),
      enqueueUpload(createTask(4, 50)),
    ];

    const results = await Promise.all(promises);

    expect(results).toEqual([1, 2, 3, 4]);
    // Concurrency limit is removed, so active tasks should be able to reach 4 (fully parallel)
    expect(maxActiveTasks).toBe(4);
  });
});
