// Builds the local-validator fixture for the real SPL Stake Pool test.
//
// Input:  stake_pool.mainnet.json, an unmodified dump of a mainnet stake pool account
//         (solana account <pool> --output json).
// Output: stake_pool.json, the same account with `manager` and `staker` replaced by a
//         throwaway test key. The test plays that key as the pool's current single-key
//         manager and hands the pool over to the council.
const fs = require("fs");
const path = require("path");
const { web3 } = require("@coral-xyz/anchor");

const text = fs.readFileSync(path.join(__dirname, "stake_pool.mainnet.json"), "utf8");
const originalBase64 = JSON.parse(text).account.data[0];
const data = Buffer.from(originalBase64, "base64");
const oldManager = web3.Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey;

const key = (offset) => new web3.PublicKey(data.subarray(offset, offset + 32)).toBase58();
console.log("account_type:", data[0], "len:", data.length);
console.log("mainnet manager:", key(1));
console.log("pool mint:", key(162));
console.log("manager fee account:", key(194));
console.log("epoch fee:", Number(data.readBigUInt64LE(338)), "/", Number(data.readBigUInt64LE(330)));
console.log("last_update_epoch:", Number(data.readBigUInt64LE(274)));
console.log("next_epoch_fee tag:", data[346]);

// StakePool layout: account_type u8 @0, manager @1, staker @33.
oldManager.toBuffer().copy(data, 1);
oldManager.toBuffer().copy(data, 33);

// Replace only the data string so large integers (rentEpoch) keep their exact text.
fs.writeFileSync(
  path.join(__dirname, "stake_pool.json"),
  text.replace(originalBase64, data.toString("base64"))
);
console.log("patched manager and staker ->", oldManager.toBase58());
