# stake_council

## 1. What it is

An Anchor program that puts stake pool management behind a council vote. A managerial
action (change the epoch fee, change how stake is split across validators) is applied only
after 2 of the 3 council wallets approve it. The pool's manager is the council account
itself, a program-derived address with no private key, so no single operator can act alone.

## 2. How it works

Instructions:

- `initialize(members, threshold, epoch_fee_bps)` creates the Council and its PoolConfig.
  The threshold must be at least 2/3 of the member count; members must be unique (max 10).
- `propose(action)` a member records an action (`SetFee` or `SetStakeDistribution`).
  The action is validated here, and the proposer's approval is counted.
- `approve()` another member adds an approval. Non-members and repeat approvals fail.
- `execute()` anyone may call it. It applies the action to the pool only if approvals
  have reached the threshold, and only once.

Accounts (all PDAs of this program):

| Account    | Seeds                              | Holds                                         |
|------------|------------------------------------|-----------------------------------------------|
| Council    | `"council"`, creator               | members, threshold, proposal counter          |
| Proposal   | `"proposal"`, council, proposal id | action, approval bitmap, executed flag        |
| PoolConfig | `"pool"`, council                  | manager (= Council), fee bps, validator weights |

```
 alice              bob               anyone
   |                 |                  |
propose(SetFee)   approve()          execute()
   |                 |                  |
   v                 v                  v
+--------------------------------+   approvals >= threshold?
| Proposal #0                    |      no  -> ThresholdNotMet
| action: SetFee 250 bps         |      yes -> write PoolConfig,
| approvals: alice, bob  (2/3)   |             mark executed
+--------------------------------+                 |
                                                   v
+----------------------+  manager   +---------------------------+
| Council (PDA, no key)| <--------- | PoolConfig: fee, weights  |
+----------------------+            +---------------------------+
```

## 3. Run the demo

```
pnpm install
anchor test
```

`anchor test` builds the program, starts a local validator, and runs
`tests/stake_council.ts`. The output shows:

- The council is created with 3 members and threshold 2; the pool manager equals the council PDA.
- Alice proposes fee 500 -> 250 bps. With 1 of 3 approvals, `execute` fails with `ThresholdNotMet`
  and the fee stays at 500.
- An outsider's approval fails with `NotAMember`; Alice approving twice fails with `AlreadyApproved`.
- Bob approves (2 of 3), `execute` succeeds, the fee is 250. A second `execute` fails with `AlreadyExecuted`.
- Carol and Bob set a 50% / 30% / 20% split across three validators the same way.
- Outsider proposals, a fee above 10000 bps, and weights that do not sum to 10000 bps are rejected at proposal time.

The local wallet in the test only pays fees. It is not a council member and cannot change the pool.

## 4. What is real and what is mocked

Real: the council, the proposal and approval accounting, the threshold check, and the rule
that the pool config changes only through `execute`. All of this runs on chain and is tested.

Mocked: the pool. In this MVP the pool settings live in a `PoolConfig` account owned by this
program, not in the SPL Stake Pool program. No stake is delegated or moved; the validator
weights are stored numbers. There is no CPI yet.

## 5. Path to a real stake pool

- Set the council PDA as the manager and the staker of an SPL Stake Pool (the stake pool
  program has `SetManager` and `SetStaker` instructions for this).
- Replace the writes in `execute` with CPIs into the stake pool program, signed with
  `invoke_signed` using the council seeds (`"council"`, creator, bump).
- `SetFee` maps to the stake pool `SetFee` instruction. `SetStakeDistribution` would turn
  into the stake pool's validator stake increase and decrease instructions, sized from the
  target weights.
- The proposal, approval, and threshold logic stays as it is.

## 6. Limitations

- No member rotation: the member list and threshold are fixed at `initialize`.
- No proposal expiry or cancel: an open proposal can be approved and executed at any later time.
- Proposals are not closed after execution, so their rent is not reclaimed.
- One council per creator wallet, and one pool per council.
