import type { WaitKind } from "./approvals.js";

export interface ParkedWait {
  readonly kind: WaitKind;
  /** Approval id or timer id. */
  readonly id: string;
  /** When the session must be looked at again (approval deadline, timer). */
  readonly at: number;
}

/**
 * In-memory registry of tool tasks that are waiting on something outside the
 * process (a human, a clock). When every live task of the session is either
 * one of these or waiting on one, the session is "parked": the invocation can
 * return and the runtime can close and release the lease, because nothing will
 * happen until a decision or the wake time arrives. The durable side of the
 * same information is `WaitsDoc`.
 */
export class Parking {
  readonly #parked = new Map<number, ParkedWait>();
  #next: { promise: Promise<void>; resolve: () => void } | undefined;

  park(taskId: number, wait: ParkedWait): void {
    this.#parked.set(taskId, wait);
    this.#notify();
  }

  unpark(taskId: number): void {
    if (this.#parked.delete(taskId)) this.#notify();
  }

  has(taskId: number): boolean {
    return this.#parked.has(taskId);
  }

  get size(): number {
    return this.#parked.size;
  }

  /** Resolves at the next park or unpark. */
  changed(): Promise<void> {
    if (this.#next === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.#next = { promise, resolve };
    }
    return this.#next.promise;
  }

  #notify(): void {
    const next = this.#next;
    this.#next = undefined;
    next?.resolve();
  }
}
