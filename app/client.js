// StakeCouncil chain client. No DOM access here, so the same code runs in the browser
// (web3 = window.solanaWeb3) and in Node (web3 = require("@coral-xyz/anchor").web3).
//
//   const client = createStakeCouncilClient(web3, idl);
//
// Instructions are encoded by hand (borsh) using the discriminators from the IDL.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.createStakeCouncilClient = factory;
})(typeof self !== "undefined" ? self : this, function createStakeCouncilClient(web3, idl) {
  const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = web3;
  const programId = new PublicKey(idl.address);
  const text = new TextEncoder();

  // ---------------------------------------------------------------- bytes
  const u8 = (n) => Uint8Array.of(n & 0xff);
  const u16 = (n) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  };
  const u32 = (n) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  };
  // web3.js types instruction data as Buffer; use one when the runtime has it.
  const asData = (bytes) => (typeof Buffer !== "undefined" ? Buffer.from(bytes) : bytes);

  class Reader {
    constructor(bytes) {
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.offset = 0;
    }
    u8() {
      return this.bytes[this.offset++];
    }
    bool() {
      return this.u8() !== 0;
    }
    u16() {
      const v = this.view.getUint16(this.offset, true);
      this.offset += 2;
      return v;
    }
    u32() {
      const v = this.view.getUint32(this.offset, true);
      this.offset += 4;
      return v;
    }
    u64() {
      const v = this.view.getBigUint64(this.offset, true);
      this.offset += 8;
      return Number(v);
    }
    raw(n) {
      const v = this.bytes.slice(this.offset, this.offset + n);
      this.offset += n;
      return v;
    }
    pubkey() {
      return new PublicKey(this.raw(32));
    }
  }

  // ----------------------------------------------------------------- IDL
  const discriminator = (name) => {
    const ix = idl.instructions.find((i) => i.name === name);
    if (!ix) throw new Error(`IDL has no instruction named ${name}`);
    return Uint8Array.from(ix.discriminator);
  };
  const accountDiscriminator = (name) =>
    Uint8Array.from(idl.accounts.find((a) => a.name === name).discriminator);
  const hasDiscriminator = (data, name) => {
    const expected = accountDiscriminator(name);
    return expected.every((byte, i) => data[i] === byte);
  };

  // ---------------------------------------------------------------- PDAs
  const councilAddress = (creator) =>
    PublicKey.findProgramAddressSync([text.encode("council"), creator.toBytes()], programId)[0];
  const poolAddress = (council) =>
    PublicKey.findProgramAddressSync([text.encode("pool"), council.toBytes()], programId)[0];
  const proposalAddress = (council, id) =>
    PublicKey.findProgramAddressSync(
      [text.encode("proposal"), council.toBytes(), u64(id)],
      programId
    )[0];

  // -------------------------------------------------------------- actions
  // { kind: "setFee", feeBps } | { kind: "setStakeDistribution", allocations: [{ validator, weightBps }] }
  const encodeAction = (action) => {
    if (action.kind === "setFee") return concat([u8(0), u16(action.feeBps)]);
    if (action.kind === "setStakeDistribution") {
      return concat([
        u8(1),
        u32(action.allocations.length),
        ...action.allocations.map((a) => concat([a.validator.toBytes(), u16(a.weightBps)])),
      ]);
    }
    throw new Error(`Cannot encode action kind ${action.kind}`);
  };

  const readAllocations = (reader) => {
    const count = reader.u32();
    const allocations = [];
    for (let i = 0; i < count; i++) {
      allocations.push({ validator: reader.pubkey(), weightBps: reader.u16() });
    }
    return allocations;
  };

  const readAction = (reader) => {
    const tag = reader.u8();
    if (tag === 0) return { kind: "setFee", feeBps: reader.u16() };
    if (tag === 1) return { kind: "setStakeDistribution", allocations: readAllocations(reader) };
    if (tag === 2) {
      const count = reader.u32();
      const accounts = [];
      for (let i = 0; i < count; i++) {
        accounts.push({ pubkey: reader.pubkey(), isSigner: reader.bool(), isWritable: reader.bool() });
      }
      const data = reader.raw(reader.u32());
      return { kind: "stakePoolInstruction", accounts, data };
    }
    throw new Error(`Unknown action tag ${tag}`);
  };

  // ------------------------------------------------------------- decoders
  const decodeCouncil = (data) => {
    if (!hasDiscriminator(data, "Council")) throw new Error("Not a Council account");
    const r = new Reader(data);
    r.raw(8);
    const creator = r.pubkey();
    const count = r.u32();
    const members = [];
    for (let i = 0; i < count; i++) members.push(r.pubkey());
    return { creator, members, threshold: r.u8(), proposalCount: r.u64(), bump: r.u8() };
  };

  const decodePool = (data) => {
    if (!hasDiscriminator(data, "PoolConfig")) throw new Error("Not a PoolConfig account");
    const r = new Reader(data);
    r.raw(8);
    return {
      manager: r.pubkey(),
      epochFeeBps: r.u16(),
      allocations: readAllocations(r),
      bump: r.u8(),
    };
  };

  const decodeProposal = (data) => {
    if (!hasDiscriminator(data, "Proposal")) throw new Error("Not a Proposal account");
    const r = new Reader(data);
    r.raw(8);
    const council = r.pubkey();
    const id = r.u64();
    const proposer = r.pubkey();
    const action = readAction(r);
    const approvals = r.u16();
    const executed = r.bool();
    const bump = r.u8();
    return { council, id, proposer, action, approvals, executed, bump };
  };

  // Which members approved, from the bitmap (bit i = members[i]).
  const approvedBy = (proposal, council) =>
    council.members.filter((_, i) => (proposal.approvals & (1 << i)) !== 0);

  // --------------------------------------------------------- instructions
  const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  const instruction = (keys, data) =>
    new TransactionInstruction({ programId, keys, data: asData(data) });

  const initializeIx = ({ creator, members, threshold, feeBps }) => {
    const council = councilAddress(creator);
    return instruction(
      [
        meta(creator, true, true),
        meta(council, false, true),
        meta(poolAddress(council), false, true),
        meta(SystemProgram.programId, false, false),
      ],
      concat([
        discriminator("initialize"),
        u32(members.length),
        ...members.map((m) => m.toBytes()),
        u8(threshold),
        u16(feeBps),
      ])
    );
  };

  const proposeIx = ({ payer, proposer, council, id, action }) =>
    instruction(
      [
        meta(payer, true, true),
        meta(proposer, true, false),
        meta(council, false, true),
        meta(proposalAddress(council, id), false, true),
        meta(SystemProgram.programId, false, false),
      ],
      concat([discriminator("propose"), encodeAction(action)])
    );

  const approveIx = ({ member, council, id }) =>
    instruction(
      [
        meta(member, true, false),
        meta(council, false, false),
        meta(proposalAddress(council, id), false, true),
      ],
      discriminator("approve")
    );

  const executeIx = ({ executor, council, id }) =>
    instruction(
      [
        meta(executor, true, false),
        meta(council, false, false),
        meta(proposalAddress(council, id), false, true),
        meta(poolAddress(council), false, true),
      ],
      discriminator("execute")
    );

  // --------------------------------------------------------------- errors
  // Turns a failed send into { name, message, code } using the IDL error list.
  const explainError = (error) => {
    let logs = [];
    try {
      if (Array.isArray(error && error.logs)) logs = error.logs;
    } catch (_) {
      /* some web3.js versions throw from the logs getter */
    }
    const haystack = `${(error && error.message) || error}\n${logs.join("\n")}`;

    const custom = haystack.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (custom) {
      const code = parseInt(custom[1], 16);
      const known = (idl.errors || []).find((e) => e.code === code);
      if (known) return { name: known.name, message: known.msg, code };
    }
    const anchor = haystack.match(/Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^"\\\n]+)/);
    if (anchor) {
      return { name: anchor[1], message: anchor[3].replace(/\.$/, ""), code: Number(anchor[2]) };
    }
    if (custom) {
      return { name: "ProgramError", message: `custom program error 0x${custom[1]}`, code: parseInt(custom[1], 16) };
    }
    const firstLine = String((error && error.message) || error).split("\n")[0];
    return { name: "Error", message: firstLine, code: null };
  };

  class CouncilError extends Error {
    constructor(details) {
      super(`${details.name}: ${details.message}`);
      this.name = "CouncilError";
      this.code = details.code;
      this.errorName = details.name;
      this.errorMessage = details.message;
    }
  }

  // ----------------------------------------------------------------- send
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Signs with payer + signers, sends, and polls for confirmation (no websocket needed).
  const send = async (connection, instructions, payer, signers = []) => {
    const tx = new Transaction();
    instructions.forEach((ix) => tx.add(ix));
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

    const unique = [payer];
    for (const signer of signers) {
      if (!unique.some((s) => s.publicKey.equals(signer.publicKey))) unique.push(signer);
    }
    tx.sign(...unique);

    let signature;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: "confirmed",
      });
    } catch (error) {
      throw new CouncilError(explainError(error));
    }

    for (let attempt = 0; attempt < 120; attempt++) {
      const status = (await connection.getSignatureStatuses([signature])).value[0];
      if (status) {
        if (status.err) {
          throw new CouncilError(explainError(new Error(JSON.stringify(status.err))));
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          return signature;
        }
      }
      await sleep(250);
    }
    throw new Error("Timed out waiting for the transaction to confirm");
  };

  // Tops up a wallet from the local faucet. Only works on a local validator or devnet.
  const ensureFunds = async (connection, pubkey, minSol = 1, airdropSol = 5) => {
    const lamportsPerSol = web3.LAMPORTS_PER_SOL;
    let balance = await connection.getBalance(pubkey, "confirmed");
    if (balance >= minSol * lamportsPerSol) return balance;
    await connection.requestAirdrop(pubkey, airdropSol * lamportsPerSol);
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(250);
      balance = await connection.getBalance(pubkey, "confirmed");
      if (balance >= minSol * lamportsPerSol) return balance;
    }
    throw new Error("Airdrop did not arrive. Is this a local validator with a faucet?");
  };

  // ---------------------------------------------------------------- reads
  // Everything the UI shows for the council created by `creator`.
  const fetchState = async (connection, creator) => {
    const council = councilAddress(creator);
    const pool = poolAddress(council);
    const [councilInfo, poolInfo] = await connection.getMultipleAccountsInfo([council, pool], "confirmed");
    if (!councilInfo) return { exists: false, councilAddress: council, poolAddress: pool, proposals: [] };

    const councilState = decodeCouncil(councilInfo.data);
    const poolState = poolInfo ? decodePool(poolInfo.data) : null;

    const addresses = [];
    for (let id = 0; id < councilState.proposalCount; id++) addresses.push(proposalAddress(council, id));
    const proposals = [];
    for (let start = 0; start < addresses.length; start += 100) {
      const chunk = addresses.slice(start, start + 100);
      const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
      infos.forEach((info, i) => {
        if (!info) return;
        const proposal = decodeProposal(info.data);
        const approvers = approvedBy(proposal, councilState);
        proposals.push({
          ...proposal,
          address: chunk[i],
          approvers,
          approvalCount: approvers.length,
          ready: !proposal.executed && approvers.length >= councilState.threshold,
        });
      });
    }
    return {
      exists: true,
      councilAddress: council,
      poolAddress: pool,
      council: councilState,
      pool: poolState,
      proposals,
    };
  };

  // -------------------------------------------------------------- actions
  const createCouncil = (connection, { payer, members, threshold, feeBps }) =>
    send(connection, [initializeIx({ creator: payer.publicKey, members, threshold, feeBps })], payer);

  // Reads the next proposal id from the council, then proposes as `proposer`.
  const propose = async (connection, { payer, proposer, council, action }) => {
    const info = await connection.getAccountInfo(council, "confirmed");
    if (!info) throw new Error("Council account not found");
    const id = decodeCouncil(info.data).proposalCount;
    const signature = await send(
      connection,
      [proposeIx({ payer: payer.publicKey, proposer: proposer.publicKey, council, id, action })],
      payer,
      [proposer]
    );
    return { id, signature };
  };

  const approve = (connection, { payer, member, council, id }) =>
    send(connection, [approveIx({ member: member.publicKey, council, id })], payer, [member]);

  // Anyone can execute; the fee payer signs as the executor.
  const execute = (connection, { payer, council, id }) =>
    send(connection, [executeIx({ executor: payer.publicKey, council, id })], payer);

  return {
    programId,
    councilAddress,
    poolAddress,
    proposalAddress,
    encodeAction,
    decodeCouncil,
    decodePool,
    decodeProposal,
    explainError,
    CouncilError,
    send,
    ensureFunds,
    fetchState,
    createCouncil,
    propose,
    approve,
    execute,
  };
});
