# About approvals, timers, and automatic resume

This page explains how a run waits for a person or a clock without holding an
HTTP invocation, and how it continues when nobody calls the runtime.

## Why a waiting run must not hold the invocation

AgentCore keeps a session's microVM alive for at most `maxLifetime` (8 h at
most) and stops it after `idleRuntimeSessionTimeout`. An approval can take
longer than either, and a replaced microVM has an empty `/tmp`. So everything
a waiting run needs has to be in DynamoDB, and the invocation has to return
while the run waits.

## What Pi Durable gives us, and what it does not

Pi Durable 1.3.0 commits each tool call's intent before `execute()` runs. After
a restart, `Harness.resume()` reruns a tool declared `replay: "safe"` with the
same task id, and does not repeat model calls whose answers are committed. A
custom session document (`defineDoc`) is committed in the same log, and a tool
can watch it (`api.watchDoc`).

Pi Durable has no "suspend until an external event" state. A task can wait
only on other tasks (`status: "waiting"`, `on: [taskIds]`), and the only timer
is `TaskRuntime.sleep()`, which is in memory. It also has no scheduler that
wakes a closed process.

This PoC builds the missing part from those pieces:

1. A gated tool commits a pending approval (or a timer's wake time) to the
   session document `app.suspensions`, then waits on that document in memory.
2. The invocation races the submission against the document and returns
   `pending` as soon as the run parks.
3. If the process dies, nothing is lost: the approval is in the commit log,
   and the tool is replay-safe. Whichever process opens the session next
   reruns the tool, which finds its approval by id (derived from the
   idempotency key) and continues if it is decided.

The approval id is `apr_` plus 32 hex characters of a hash of the tool's
idempotency key. It is stable across reruns and grants nothing. Deciding needs
the approver token, which the requester never receives.

## Choosing the wake mechanism

Something outside the runtime has to call it when a deadline passes, a timer
fires, or a crashed run needs to continue. The options considered:

| Option | Why not, or why |
| --- | --- |
| DynamoDB TTL + Streams | TTL deletes items up to days late. Fine for cleanup, wrong for deadlines. |
| SQS delay queues | Delays stop at 15 minutes, so an 8 h wait needs a chain of re-enqueues. |
| EventBridge Scheduler, one schedule per wake | Exact timing, but a crashed run needs a heartbeat, and moving a schedule every few seconds costs an `UpdateSchedule` call per heartbeat. The runtime would also need `scheduler:*` and `iam:PassRole`. |
| **Scheduled sweep of a wake index (chosen)** | One EventBridge rule runs a small Lambda every minute. The runtime keeps one wake item per session with a plain `UpdateItem`, which it already has permission for. Heartbeats are cheap writes. |

The cost of the chosen design is precision: a wake fires up to one sweep
interval plus `PI_WAKE_GRACE_MS` late. For approvals measured in hours that
does not matter.

Wake items live in the existing table under the partition key `WAKE`, so the
table needs no new index. The sweep reads that one partition with a filter,
so it reads every session that has a wake item, due or not. That is fine for a
PoC. With many thousands of waiting sessions, shard the partition key or add a
sparse GSI (a table update without replacement).

## How a wake item tracks the session

The runtime derives the plan from committed state after every commit and on a
heartbeat (`suspensions.ts`, `wakePlan`):

| Committed state | Wake item |
| --- | --- |
| A pending approval or a waiting timer | `dueAt` = earliest deadline or wake time |
| A run in flight, not parked | `dueAt` = now + `PI_WAKE_GRACE_MS`, rewritten every third of that |
| Nothing to do | item deleted |

A crash stops the heartbeat, so `dueAt` passes and the next sweep resumes the
session. Each write is conditional on the writer's lease fencing token, so a
stale process cannot overwrite a newer owner's plan.

## What a resume invocation does

The resumer sends `{"action":"resume"}` with the stored AgentCore session id.
That id is on the wake item because `InvokeAgentRuntime` needs it; the
idempotency keys and partition keys use only its hash.

Opening the runtime calls `Harness.resume()`, which reruns interrupted
replay-safe tools and timers. `resume` then rejects approvals whose deadline
passed (decided by `timeout`), waits for the run to answer or park again
(up to `PI_RESUME_WAIT_MS`), and the runtime rewrites the wake item.

Racing resumers converge:

- Two sweeps claim an item with a conditional update. Only one invokes.
- Two resume invocations in one process share the same run and get the same
  answer.
- A resume on a second process cannot take the lease and gets 409. The next
  sweep after the claim expires tries again.
- An approval and a timeout race inside one Pi commit line, and the first
  decision wins.

## Limits

- Pi's replay rule is at-least-once: a tool interrupted after its side effect
  but before its result commit runs again. The idempotency key is how the
  external system drops the repeat (`effects.ts` shows the pattern).
- While a parked tool waits in memory, its process holds the session lease.
  AgentCore routes a session id to one microVM, so this only matters if two
  microVMs ever serve one session. The second one then gets 409 until the
  first stops.
- The approver token is a shared secret checked by hash. A production
  deployment would authenticate approvers with AgentCore inbound JWT auth and
  check a claim instead.
