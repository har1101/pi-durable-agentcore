import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RecordedEvent {
  position: number;
  timestamp: string;
  pid: number;
  sessionId: string;
  kind: string;
  detail: unknown;
}

export class EventRecorder {
  readonly path: string;
  readonly sessionId: string;
  #position = 0;
  #tail: Promise<void> = Promise.resolve();

  private constructor(path: string, sessionId: string) {
    this.path = path;
    this.sessionId = sessionId;
  }

  static async open(path: string, sessionId: string): Promise<EventRecorder> {
    await mkdir(dirname(path), { recursive: true });
    const recorder = new EventRecorder(path, sessionId);
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      const previous = lines.at(-1);
      if (previous) {
        recorder.#position = (JSON.parse(previous) as RecordedEvent).position;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return recorder;
  }

  record(kind: string, detail: unknown): Promise<void> {
    const event: RecordedEvent = {
      position: ++this.#position,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      sessionId: this.sessionId,
      kind,
      detail,
    };
    const line = `${JSON.stringify(event)}\n`;
    this.#tail = this.#tail.then(async () => {
      await appendFile(this.path, line, "utf8");
      process.stdout.write(
        `[checkpoint ${event.position}] ${event.kind} ${JSON.stringify(event.detail)}\n`,
      );
    });
    return this.#tail;
  }

  flush(): Promise<void> {
    return this.#tail;
  }
}
