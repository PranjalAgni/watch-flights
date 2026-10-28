export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `concurrency` tasks at once; the rest wait in FIFO order. */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError("concurrency must be a positive integer");
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        Promise.resolve().then(task).then(resolve, reject).finally(next);
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
}
