import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { StakeCouncil } from "../target/types/stake_council";

describe("stake_council: a 2-of-3 council is the only manager of the stake pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.stakeCouncil as Program<StakeCouncil>;
  const { PublicKey, Keypair } = anchor.web3;

  // The local wallet only pays fees. It is NOT a council member and has no power over the pool.
  const payer = provider.wallet.publicKey;
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const carol = Keypair.generate();
  const mallory = Keypair.generate(); // outsider

  const [council] = PublicKey.findProgramAddressSync(
    [Buffer.from("council"), payer.toBuffer()],
    program.programId
  );
  const [pool] = PublicKey.findProgramAddressSync(
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

  const propose = (action: any, proposer: anchor.web3.Keypair, id: number) =>
    program.methods
      .propose(action)
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
      .accountsPartial({
        member: member.publicKey,
        council,
        proposal: proposalPda(id),
      })
      .signers([member])
      .rpc();

  // Anyone may crank execute; pass a keypair to vary the signer.
  const execute = (id: number, executor?: anchor.web3.Keypair) => {
    const builder = program.methods.execute().accountsPartial({
      executor: executor ? executor.publicKey : payer,
      council,
      proposal: proposalPda(id),
      pool,
    });
    return executor ? builder.signers([executor]).rpc() : builder.rpc();
  };

  it("creates the council; the pool manager is a PDA nobody holds a key for", async () => {
    await program.methods
      .initialize([alice.publicKey, bob.publicKey, carol.publicKey], 2, 500)
      .accountsPartial({ creator: payer, council, pool })
      .rpc();

    const councilState = await program.account.council.fetch(council);
    const poolState = await program.account.poolConfig.fetch(pool);
    assert.equal(councilState.members.length, 3);
    assert.equal(councilState.threshold, 2);
    assert.ok(poolState.manager.equals(council));
    assert.equal(poolState.epochFeeBps, 500);
    console.log(`      council (pool manager PDA): ${council.toBase58()}`);
    console.log(`      pool fee: ${poolState.epochFeeBps} bps, threshold 2 of 3`);
  });

  it("fee change: 1 of 3 approvals cannot execute, 2 of 3 can", async () => {
    await propose({ setFee: { feeBps: 250 } }, alice, 0);
    console.log("      alice proposed: fee 500 -> 250 bps (1/3 approvals)");

    await expectError(execute(0), "ThresholdNotMet");
    await expectError(approve(mallory, 0), "NotAMember");
    await expectError(approve(alice, 0), "AlreadyApproved");
    assert.equal((await program.account.poolConfig.fetch(pool)).epochFeeBps, 500);

    await approve(bob, 0);
    console.log("      bob approved (2/3 approvals)");
    await execute(0);

    const poolState = await program.account.poolConfig.fetch(pool);
    assert.equal(poolState.epochFeeBps, 250);
    console.log(`      executed: pool fee is now ${poolState.epochFeeBps} bps`);

    await expectError(execute(0, bob), "AlreadyExecuted");
  });

  it("stake distribution: any 2 members can re-weight validators", async () => {
    const validators = [0, 1, 2].map(() => Keypair.generate().publicKey);
    const allocations = [
      { validator: validators[0], weightBps: 5000 },
      { validator: validators[1], weightBps: 3000 },
      { validator: validators[2], weightBps: 2000 },
    ];

    await propose({ setStakeDistribution: { allocations } }, carol, 1);
    await expectError(execute(1), "ThresholdNotMet");
    await approve(bob, 1);
    await execute(1);

    const poolState = await program.account.poolConfig.fetch(pool);
    assert.deepEqual(
      poolState.allocations.map((a: any) => [a.validator.toBase58(), a.weightBps]),
      allocations.map((a) => [a.validator.toBase58(), a.weightBps])
    );
    console.log(
      `      executed: stake split ${poolState.allocations
        .map((a: any) => `${a.weightBps / 100}%`)
        .join(" / ")} across 3 validators`
    );
  });

  it("rejects outsiders and malformed actions at proposal time", async () => {
    await expectError(propose({ setFee: { feeBps: 300 } }, mallory, 2), "NotAMember");
    await expectError(propose({ setFee: { feeBps: 10001 } }, alice, 2), "InvalidFee");
    const validator = Keypair.generate().publicKey;
    await expectError(
      propose(
        { setStakeDistribution: { allocations: [{ validator, weightBps: 9000 }] } },
        alice,
        2
      ),
      "InvalidDistribution"
    );
  });
});
