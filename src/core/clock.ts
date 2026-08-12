/** Injectable clock — continuity and watchdog tests need deterministic time travel. */
export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export class ManualClock implements Clock {
  #at: number;

  constructor(start: string | number | Date = "2026-01-01T00:00:00.000Z") {
    this.#at = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#at);
  }

  nowIso(): string {
    return new Date(this.#at).toISOString();
  }

  advance(ms: number): void {
    this.#at += ms;
  }

  set(at: string | number | Date): void {
    this.#at = new Date(at).getTime();
  }
}

export const isoPlus = (from: string, ms: number): string =>
  new Date(new Date(from).getTime() + ms).toISOString();

export const isBefore = (a: string, b: string): boolean =>
  new Date(a).getTime() < new Date(b).getTime();
