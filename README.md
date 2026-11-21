# StakeCouncil

**Council-controlled management for Solana stake pools. Fees and stake only move when 2 of 3 operators agree, and nobody holds the manager key.**

## Why

A stake pool holds other people's SOL, yet two keys decide everything about it. The *manager* sets the fees. The *staker* decides which validators receive the stake. Whoever holds those keys can raise fees or redirect stake alone, and one leaked key puts every depositor at risk.

StakeCouncil removes the single key. The pool's authority is a program-derived address with no private key. The only way to use that authority is a proposal that a 2/3 supermajority of the council's wallets has approved on chain. Operators keep their own wallets. No secret is shared, stored on a server, or handed to one person.

## How it works

1. **Propose.** A council member proposes a managerial action from their own wallet.
2. **Approve.** Other members approve. Outsiders and repeat approvals are rejected.
3. **Execute.** Once approvals reach the threshold, anyone can execute. The program applies the action, acting as the council address.

```
 alice              bob               anyone
   |                 |                  |
propose(action)   approve()          execute()
   |                 |                  |
   v                 v                  v
+--------------------------------+   approvals >= threshold?
| Proposal #0                    |      no  -> ThresholdNotMet
| action: fee 5% -> 2.5%         |      yes -> apply the action,
| approvals: alice, bob  (2/3)   |             mark executed
+--------------------------------+                 |
                                                   v
+-----------------------+  manager   +---------------------------+
| Council (PDA, no key) | <--------- | Stake pool                |
+-----------------------+            +---------------------------+
```

| Account | Seeds | Holds |
|---|---|---|
| `Council` | `"council"`, creator | members, threshold, proposal counter |
| `Proposal` | `"proposal"`, council, id | the action, approval bitmap, executed flag |
| `PoolConfig` | `"pool"`, council | manager (the council), fee, validator weights |

The rules the program enforces:

- The threshold must be at least 2/3 of the members, and members must be unique.
- Only members can propose or approve, and each member counts once.
- A proposal executes once, and only after the threshold is met.
- Actions are validated when proposed: fees cannot exceed 100%, and validator weights must be unique and sum to 100%.

## What the council controls

| Action | What it does | Status |
|---|---|---|
| `SetFee` | Changes the pool fee | Tested |
| `SetStakeDistribution` | Sets the share of stake each validator should receive | Tested |

## Run it

```
pnpm install
anchor test
```

Needs Anchor 0.31.1 and the Solana CLI 2.x. `anchor test` builds the program, starts a local validator and runs the suite:

```
stake_council: a 2-of-3 council is the only manager of the stake pool
  ✔ creates the council; the pool manager is a PDA nobody holds a key for
      alice proposed: fee 500 -> 250 bps (1/3 approvals)
      rejected as expected: ThresholdNotMet
      rejected as expected: NotAMember
      rejected as expected: AlreadyApproved
      bob approved (2/3 approvals)
      executed: pool fee is now 250 bps
      rejected as expected: AlreadyExecuted
  ✔ fee change: 1 of 3 approvals cannot execute, 2 of 3 can
      executed: stake split 50% / 30% / 20% across 3 validators
  ✔ stake distribution: any 2 members can re-weight validators
  ✔ rejects outsiders and malformed actions at proposal time
```

The wallet that runs the test only pays fees. It is not a council member and cannot change the pool.

## Repo map

| Path | What |
|---|---|
| [`programs/stake_council/src/lib.rs`](programs/stake_council/src/lib.rs) | The program |
| [`tests/stake_council.ts`](tests/stake_council.ts) | The test suite |
| [`docs/claude-workspace.md`](docs/claude-workspace.md) | Notes on the Claude Code workspace this was built in |

## Status and limits

- `SetFee` and `SetStakeDistribution` currently update `PoolConfig`, an account this program owns that records the council's decisions. They do not yet move stake on a live pool.
- No member rotation: members and threshold are fixed when the council is created.
- Proposals do not expire and cannot be cancelled, so an approved proposal stays executable.
- Executed proposals are not closed, so their rent is not reclaimed.
