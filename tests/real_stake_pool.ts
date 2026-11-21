import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { StakeCouncil } from "../target/types/stake_council";

// This suite runs against the real SPL Stake Pool program: its binary is loaded into the
// local validator from tests/fixtures/spl_stake_pool.so. The pool is a copy of a mainnet
// stake pool account whose manager and staker were replaced by a throwaway key
// (tests/fixtures/make-fixture.js), so the test can play the pool's current operator.
describe("real SPL Stake Pool: a council takes over a pool and runs it by 2-of-3 vote", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.stakeCouncil as Program<StakeCouncil>;
  const { PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction } = anchor.web3;

  const STAKE_POOL_PROGRAM = new PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
  const STAKE_POOL = new PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");

  const payer = provider.wallet.publicKey; // pays fees only
  const oldManager = Keypair.fromSeed(Buffer.alloc(32, 1)); // the pool's single manager key before the takeover
  const creator = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const mallory = Keypair.generate();

  const [council] = PublicKey.findProgramAddressSync(
    [Buffer.from("council"), creator.publicKey.toBuffer()],
    program.programId
  );
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), council.toBuffer()],
    program.programId
  );
  const proposalPda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("proposal"),
        council.toBuffer(),
        new anchor.BN(id).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  // SPL Stake Pool instruction data (borsh). The first byte is the variant index in
  // StakePoolInstruction: SetManager = 11, SetFee = 12, SetStaker = 13. FeeType::Epoch = 2,
  // and Fee is { denominator: u64, numerator: u64 }.
  const u64 = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);
  const SET_MANAGER = Buffer.from([11]);
  const SET_STAKER = Buffer.from([13]);
  const setEpochFee = (numerator: number, denominator: number) =>
    Buffer.concat([Buffer.from([12, 2]), u64(denominator), u64(numerator)]);

  // StakePool account layout: manager @1, staker @33, manager_fee_account @194,
  // epoch_fee @330 (denominator, numerator), next_epoch_fee @346 (tag, then a Fee).
  const readPool = async () => {
    const info = await provider.connection.getAccountInfo(STAKE_POOL);
    const d = info!.data;
    const fee = (offset: number) => ({
      numerator: Number(d.readBigUInt64LE(offset + 8)),
      denominator: Number(d.readBigUInt64LE(offset)),
    });
    return {
      manager: new PublicKey(d.subarray(1, 33)),
      staker: new PublicKey(d.subarray(33, 65)),
      managerFeeAccount: new PublicKey(d.subarray(194, 226)),
      epochFee: fee(330),
      nextEpochFee: d[346] === 0 ? null : fee(347),
    };
  };

  const meta = (pubkey: anchor.web3.PublicKey, isSigner: boolean, isWritable: boolean) => ({
    pubkey,
    isSigner,
    isWritable,
  });

  const propose = (accounts: any[], data: Buffer, proposer: anchor.web3.Keypair, id: number) =>
    program.methods
      .propose({ stakePoolInstruction: { accounts, data } })
      .accountsPartial({
        payer,
        proposer: proposer.publicKey,
        council,
        proposal: proposalPda(id),
      })
      .signers([proposer])
      .rpc();

  const approve = (member: anchor.web3.Keypair, id: number) =>
    program.methods
      .approve()
      .accountsPartial({ member: member.publicKey, council, proposal: proposalPda(id) })
      .signers([member])
      .rpc();

  // remaining accounts = [stake pool program, ...the approved instruction's accounts].
  // The council PDA cannot sign a transaction; the program signs for it during the CPI.
  const execute = (accounts: any[], id: number, extraSigners: anchor.web3.Keypair[] = []) =>
    program.methods
      .execute()
      .accountsPartial({
        executor: payer,
        council,
        proposal: proposalPda(id),
        pool: poolConfig,
      })
      .remainingAccounts([
        meta(STAKE_POOL_PROGRAM, false, false),
        ...accounts.map((a) => meta(a.pubkey, a.isSigner && !a.pubkey.equals(council), a.isWritable)),
      ])
      .signers(extraSigners)
      .rpc();

  const expectError = async (promise: Promise<unknown>, code: string) => {
    try {
      await promise;
    } catch (e: any) {
      const got = e?.error?.errorCode?.code ?? String(e);
      assert.include(String(got), code, `expected ${code}, got: ${e}`);
      console.log(`      rejected as expected: ${code}`);
      return;
    }
    assert.fail(`expected the transaction to fail with ${code}`);
  };

  before(async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: creator.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        })
      )
    );
    await program.methods
      .initialize([alice.publicKey, bob.publicKey, carol.publicKey], 2, 400)
      .accountsPartial({ creator: creator.publicKey, council, pool: poolConfig })
      .signers([creator])
      .rpc();
  });

  it("starts with one key in charge of the pool", async () => {
    const pool = await readPool();
    assert.ok(pool.manager.equals(oldManager.publicKey));
    assert.ok(pool.staker.equals(oldManager.publicKey));
    console.log(`      stake pool:  ${STAKE_POOL.toBase58()}`);
    console.log(`      manager key: ${pool.manager.toBase58()} (a single keypair)`);
    console.log(`      epoch fee:   ${pool.epochFee.numerator}/${pool.epochFee.denominator}`);
  });

  it("takeover: the old manager and a 2-of-3 vote hand the pool to the council address", async () => {
    const { managerFeeAccount } = await readPool();
    // SetManager accounts: stake pool (w), manager (s), new manager (s), new fee receiver
    const accounts = [
      meta(STAKE_POOL, false, true),
      meta(oldManager.publicKey, true, false),
      meta(council, true, false),
      meta(managerFeeAccount, false, false),
    ];
    await propose(accounts, SET_MANAGER, alice, 0);
    await expectError(execute(accounts, 0, [oldManager]), "ThresholdNotMet");
    await approve(bob, 0);
    await execute(accounts, 0, [oldManager]);

    const pool = await readPool();
    assert.ok(pool.manager.equals(council));
    console.log(`      pool manager is now the council PDA: ${pool.manager.toBase58()}`);
  });

  it("the old manager key can no longer change the fee", async () => {
    const instruction = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM,
      keys: [meta(STAKE_POOL, false, true), meta(oldManager.publicKey, true, false)],
      data: setEpochFee(10, 100),
    });
    let rejected = false;
    try {
      await provider.sendAndConfirm(new Transaction().add(instruction), [oldManager]);
    } catch (e: any) {
      rejected = true;
      const line = (e?.logs ?? []).find((l: string) => l.includes("Error") || l.includes("failed"));
      console.log(`      stake pool program rejected the old key: ${line ?? String(e).split("\n")[0]}`);
    }
    assert.ok(rejected, "the old manager key should have been rejected");
    assert.isNull((await readPool()).nextEpochFee);
  });

  it("fee change on the real pool: 1 of 3 is rejected, 2 of 3 goes through", async () => {
    // SetFee accounts: stake pool (w), manager (s)
    const accounts = [meta(STAKE_POOL, false, true), meta(council, true, false)];
    await propose(accounts, setEpochFee(250, 10000), carol, 1);
    await expectError(execute(accounts, 1), "ThresholdNotMet");
    await expectError(approve(mallory, 1), "NotAMember");
    assert.isNull((await readPool()).nextEpochFee);

    await approve(alice, 1);
    await execute(accounts, 1);

    const pool = await readPool();
    assert.deepEqual(pool.nextEpochFee, { numerator: 250, denominator: 10000 });
    console.log(
      `      stake pool next epoch fee: ${pool.nextEpochFee!.numerator}/${pool.nextEpochFee!.denominator} ` +
        `(was ${pool.epochFee.numerator}/${pool.epochFee.denominator})`
    );
  });

  it("staker authority: the council appoints who may move stake between validators", async () => {
    // SetStaker accounts: stake pool (w), manager or current staker (s), new staker
    const accounts = [
      meta(STAKE_POOL, false, true),
      meta(council, true, false),
      meta(council, false, false),
    ];
    await propose(accounts, SET_STAKER, bob, 2);
    await approve(carol, 2);

    // Executing with an account that was not approved is rejected.
    const tampered = [accounts[0], accounts[1], meta(mallory.publicKey, false, false)];
    await expectError(execute(tampered, 2), "AccountsMismatch");

    await execute(accounts, 2);
    const pool = await readPool();
    assert.ok(pool.staker.equals(council));
    console.log(`      pool staker is now the council PDA: ${pool.staker.toBase58()}`);
  });
});
