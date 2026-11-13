import { availableParallelism } from 'node:os';

export function resolveConcurrency(value = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))) {
    if (!Number.isInteger(value) || value < 1 || value > 16) {
        throw new Error('concurrency must be an integer between 1 and 16');
    }
    return value;
}

/** Stop assigning work on failure, but drain active tasks before returning or releasing locks. */
export async function runConcurrent(tasks, concurrency) {
    const results = new Array(tasks.length);
    let nextIndex = 0;
    let failed = false;
    let failure;

    async function runWorker() {
        while (!failed && nextIndex < tasks.length) {
            const index = nextIndex++;
            try {
                results[index] = await tasks[index]();
            } catch (error) {
                if (!failed) {
                    failed = true;
                    failure = error;
                }
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runWorker));
    if (failed) {
        throw failure;
    }
    return results;
}
