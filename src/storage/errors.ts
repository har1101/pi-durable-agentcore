/** Another process holds an unexpired single-writer lease for this session. */
export class LeaseContentionError extends Error {
  constructor(message = "DynamoDB session lease is held by another owner") {
    super(message);
    this.name = "LeaseContentionError";
  }
}

/**
 * This process's fencing token is no longer current. A later owner stole the
 * lease after expiry; writes must not proceed even if this process is still alive.
 */
export class FencedWriterError extends Error {
  constructor(message = "DynamoDB session lease fencing token is no longer current") {
    super(message);
    this.name = "FencedWriterError";
  }
}
