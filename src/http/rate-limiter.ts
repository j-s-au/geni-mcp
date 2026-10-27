// Serialises API calls and spaces them out. Geni allows 40 requests per 10 s
// for user tokens, but this server is deliberately far slower by default and
// also honours the X-API-Rate-* headers Geni returns.

export interface RateState {
  readonly limit?: number;
  readonly remaining?: number;
  readonly windowSeconds?: number;
  readonly observedAt?: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private state: RateState = {};
  private pausedUntil = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly minIntervalMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  /** Runs `fn` once every earlier call has started and the spacing rules allow. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.waitTurn();
      this.lastStart = this.clock.now();
    });
    // The queue only tracks start order; failures must not block later calls.
    this.queue = run.catch(() => undefined);
    return run.then(fn);
  }

  /** Re-checks after every sleep: a pause or empty window can start while this call is waiting. */
  private async waitTurn(): Promise<void> {
    for (let wait = this.nextWait(); wait > 0; wait = this.nextWait()) await this.clock.sleep(wait);
  }

  private nextWait(): number {
    const now = this.clock.now();
    let wait = Math.max(this.lastStart + this.minIntervalMs, this.pausedUntil) - now;
    const { remaining, windowSeconds, observedAt } = this.state;
    if (remaining !== undefined && remaining <= 0 && observedAt !== undefined) {
      const windowEnd = observedAt + (windowSeconds ?? 10) * 1000;
      wait = Math.max(wait, windowEnd - now);
    }
    return wait;
  }

  /** Holds every queued and future call until `ms` from now (after throttling). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  /** Records the X-API-Rate-* headers from a response. */
  observe(headers: Headers): void {
    const num = (name: string) => {
      const raw = headers.get(name);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const limit = num("x-api-rate-limit");
    const remaining = num("x-api-rate-remaining");
    const windowSeconds = num("x-api-rate-window");
    if (limit === undefined && remaining === undefined && windowSeconds === undefined) return;
    this.state = { limit, remaining, windowSeconds, observedAt: this.clock.now() };
  }

  snapshot(): RateState {
    return { ...this.state };
  }
}
