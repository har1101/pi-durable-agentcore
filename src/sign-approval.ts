import { APPROVAL_ID_PATTERN, signApproval } from "./approvals.js";

/**
 * Approver-side helper: prints the `/invocations` payload that answers one
 * pending approval. Run it where APPROVAL_SIGNING_KEY lives (the approver's
 * side), never on the requester's side.
 *
 *   APPROVAL_SIGNING_KEY=... node dist/sign-approval.js apr_<32 hex> approve
 */
const [approvalId, decision, ...rest] = process.argv.slice(2);
const key = process.env.APPROVAL_SIGNING_KEY ?? "";
if (
  approvalId === undefined ||
  !APPROVAL_ID_PATTERN.test(approvalId) ||
  (decision !== "approve" && decision !== "reject")
) {
  process.stderr.write(
    "Usage: sign-approval.js <apr_...> <approve|reject> [reason...]\n",
  );
  process.exit(2);
}
if (key.length < 32) {
  process.stderr.write("APPROVAL_SIGNING_KEY must be at least 32 characters\n");
  process.exit(2);
}
const reason = rest.join(" ").trim();
process.stdout.write(
  `${JSON.stringify({
    type: "approval",
    approvalId,
    decision,
    signature: signApproval(key, approvalId, decision),
    ...(reason !== "" ? { reason } : {}),
  })}\n`,
);
