import { parseApprovalId, TIMEOUT, type Decision, type ParkId } from "./parks.js";

/** A POST /invocations body, parsed once at the boundary. */
export type Invocation =
  | {
      readonly action: "invoke";
      readonly prompt: string;
      readonly requestId?: string;
    }
  | {
      readonly action: "decide";
      readonly approval: ParkId;
      readonly decision: Decision;
    }
  | { readonly action: "resume" };

export type Parsed =
  | { readonly ok: true; readonly invocation: Invocation }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): Parsed => ({ ok: false, message });

export function parseInvocation(body: unknown): Parsed {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("body must be a JSON object");
  }
  const input = body as Record<string, unknown>;
  switch (input.action) {
    case undefined: {
      if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
        return fail("prompt must be a non-empty string");
      }
      if (input.requestId !== undefined && typeof input.requestId !== "string") {
        return fail("requestId must be a string");
      }
      return {
        ok: true,
        invocation: {
          action: "invoke",
          prompt: input.prompt,
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        },
      };
    }
    case "decide": {
      const approval = parseApprovalId(input.approvalId);
      if (approval === undefined) {
        return fail('approvalId must be "apr_" followed by 32 lowercase hex digits');
      }
      if (input.decision !== "approve" && input.decision !== "reject") {
        return fail('decision must be exactly "approve" or "reject"');
      }
      return {
        ok: true,
        invocation: { action: "decide", approval, decision: input.decision },
      };
    }
    case "resume":
      return { ok: true, invocation: { action: "resume" } };
    default:
      return fail('action must be "decide" or "resume", or absent to invoke');
  }
}

/** APPROVER_USER_IDS, comma separated. Empty means nobody may decide: decide fails closed. */
export function parseApprovers(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "" && id !== TIMEOUT),
  );
}

/** PI_APPROVAL_TIMEOUT_MS: unset means one day; anything else must be a positive integer of milliseconds. */
export function parseApprovalTimeout(value: string | undefined): number {
  if (value === undefined) return 86_400_000;
  const ms = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(ms)) {
    throw new Error(
      `PI_APPROVAL_TIMEOUT_MS must be a positive integer of milliseconds, got ${JSON.stringify(value)}`,
    );
  }
  return ms;
}

/** The approver's user id, or undefined when the caller may not decide. */
export function authorizedApprover(
  userId: string | undefined,
  approvers: ReadonlySet<string>,
): string | undefined {
  return userId !== undefined && approvers.has(userId) ? userId : undefined;
}
