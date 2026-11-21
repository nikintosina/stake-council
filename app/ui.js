// Browser UI for the StakeCouncil demo. All chain logic lives in client.js.
(function () {
  const web3 = window.solanaWeb3;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);

  if (!web3 || !window.createStakeCouncilClient) {
    $("status").textContent = "Could not load @solana/web3.js from the CDN. Check your network connection and reload.";
    return;
  }

  const STORAGE_KEY = "stake-council-demo-v1";
  const ROLES = [
    { id: "alice", name: "Alice", tag: "council member" },
    { id: "bob", name: "Bob", tag: "council member" },
    { id: "carol", name: "Carol", tag: "council member" },
    { id: "mallory", name: "Mallory", tag: "outsider" },
  ];
  const MEMBER_IDS = ["alice", "bob", "carol"];
  const THRESHOLD = 2;

  const state = {
    client: null,
    connection: null,
    keys: null,
    role: "alice",
    chain: null,
    busy: false,
    log: [],
  };

  // ------------------------------------------------------------ helpers
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else if (key === "style") node.setAttribute("style", value);
      else node.setAttribute(key, value);
    });
    [].concat(children || []).forEach((child) => {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  };
  const replace = (node, children) => {
    node.textContent = "";
    [].concat(children).forEach((child) => child && node.appendChild(child));
  };
  const short = (pubkey) => {
    const s = pubkey.toBase58();
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
  };
  const percent = (bps) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

  // ---------------------------------------------------------- demo keys
  const generateKeys = () => ({
    payer: web3.Keypair.generate(),
    alice: web3.Keypair.generate(),
    bob: web3.Keypair.generate(),
    carol: web3.Keypair.generate(),
    mallory: web3.Keypair.generate(),
    validators: [0, 1, 2].map(() => web3.Keypair.generate().publicKey),
  });
  const saveKeys = (keys) => {
    try {
      const out = { validators: keys.validators.map((v) => v.toBase58()) };
      ["payer", "alice", "bob", "carol", "mallory"].forEach((id) => {
        out[id] = Array.from(keys[id].secretKey);
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (_) {
      /* storage unavailable: keys last until the page is reloaded */
    }
  };
  const loadKeys = () => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        const keys = { validators: saved.validators.map((v) => new web3.PublicKey(v)) };
        ["payer", "alice", "bob", "carol", "mallory"].forEach((id) => {
          keys[id] = web3.Keypair.fromSecretKey(Uint8Array.from(saved[id]));
        });
        return keys;
      }
    } catch (_) {
      /* fall through to fresh keys */
    }
    const keys = generateKeys();
    saveKeys(keys);
    return keys;
  };

  const nameOf = (pubkey) => {
    const found = ROLES.find((role) => state.keys[role.id].publicKey.equals(pubkey));
    if (found) return found.name;
    if (state.keys.payer.publicKey.equals(pubkey)) return "Fee payer";
    return short(pubkey);
  };
  const currentRole = () => ROLES.find((role) => role.id === state.role);

  // ---------------------------------------------------------------- log
  const addLog = (kind, message) => {
    state.log.unshift({ kind, message, time: new Date().toLocaleTimeString() });
    state.log = state.log.slice(0, 60);
    renderLog();
  };
  const renderLog = () => {
    if (!state.log.length) return;
    replace(
      $("log"),
      state.log.map((entry) =>
        el("li", {}, [
          el("span", { class: "muted small", text: `${entry.time}  ` }),
          el("span", { class: entry.kind === "err" ? "err" : entry.kind === "ok" ? "ok" : "", text: entry.message }),
        ])
      )
    );
  };

  // ------------------------------------------------------------- render
  const renderRoles = () => {
    replace(
      $("roles"),
      ROLES.map((role) =>
        el(
          "button",
          {
            "aria-pressed": String(state.role === role.id),
            onclick: () => {
              state.role = role.id;
              render();
            },
          },
          [role.name, el("span", { class: "tag", text: `${role.tag} · ${short(state.keys[role.id].publicKey)}` })]
        )
      )
    );
  };

  const renderCouncil = () => {
    const chain = state.chain;
    if (!state.connection) {
      replace($("council"), el("p", { class: "muted", text: "Connect to a validator to begin." }));
      return;
    }
    if (!chain || !chain.exists) {
      const feeInput = el("input", { type: "number", id: "initial-fee", value: "500", min: "0", max: "10000" });
      replace($("council"), [
        el("p", { text: "No council yet. Create one with Alice, Bob and Carol as members. Any change will need 2 of the 3." }),
        el("div", { class: "row", style: "margin-top:10px" }, [
          el("label", {}, ["Starting fee ", feeInput, " bps"]),
          el("button", {
            class: "primary",
            text: "Create council",
            onclick: () =>
              run("Create council", async () => {
                await state.client.createCouncil(state.connection, {
                  payer: state.keys.payer,
                  members: MEMBER_IDS.map((id) => state.keys[id].publicKey),
                  threshold: THRESHOLD,
                  feeBps: Number(feeInput.value),
                });
                return "Council created. Its address is now the pool manager.";
              }),
          }),
        ]),
      ]);
      return;
    }
    const council = chain.council;
    replace($("council"), [
      el("dl", {}, [
        el("dt", { text: "Pool manager" }),
        el("dd", {}, [
          el("code", { text: chain.councilAddress.toBase58() }),
          el("div", { class: "small muted", text: "A program address. No private key exists for it." }),
        ]),
        el("dt", { text: "Members" }),
        el("dd", { text: council.members.map(nameOf).join(", ") }),
        el("dt", { text: "Threshold" }),
        el("dd", { text: `${council.threshold} of ${council.members.length} must approve` }),
        el("dt", { text: "Proposals" }),
        el("dd", { text: String(council.proposalCount) }),
      ]),
    ]);
  };

  const renderPool = () => {
    const chain = state.chain;
    if (!chain || !chain.exists || !chain.pool) {
      replace($("pool"), el("p", { class: "muted", text: "The pool appears once the council exists." }));
      return;
    }
    const pool = chain.pool;
    const children = [
      el("div", { class: "muted small", text: "Fee" }),
      el("div", { class: "big", text: percent(pool.epochFeeBps) }),
      el("div", { class: "muted small", text: `${pool.epochFeeBps} bps` }),
      el("div", { class: "muted small", style: "margin-top:14px", text: "Stake distribution" }),
    ];
    if (!pool.allocations.length) {
      children.push(el("p", { class: "muted", text: "Not set yet. Propose one below." }));
    } else {
      pool.allocations.forEach((allocation, i) => {
        children.push(
          el("div", { class: "bar-row" }, [
            el("div", { class: "row small", style: "justify-content:space-between" }, [
              el("span", { text: `Validator ${i + 1} · ${short(allocation.validator)}` }),
              el("span", { text: percent(allocation.weightBps) }),
            ]),
            el("div", { class: "bar" }, el("span", { style: `width:${allocation.weightBps / 100}%` })),
          ])
        );
      });
    }
    replace($("pool"), children);
  };

  const describeAction = (action) => {
    if (action.kind === "setFee") return `Set the fee to ${percent(action.feeBps)} (${action.feeBps} bps)`;
    if (action.kind === "setStakeDistribution") {
      return `Set the stake distribution to ${action.allocations.map((a) => percent(a.weightBps)).join(" / ")}`;
    }
    return `SPL Stake Pool instruction (${action.accounts.length} accounts, ${action.data.length} bytes of data)`;
  };

  const renderProposals = () => {
    const chain = state.chain;
    if (!chain || !chain.exists || !chain.proposals.length) {
      replace($("proposals"), el("p", { class: "muted", text: "No proposals yet." }));
      return;
    }
    const council = chain.council;
    const role = currentRole();
    replace(
      $("proposals"),
      chain.proposals
        .slice()
        .reverse()
        .map((proposal) => {
          const status = proposal.executed
            ? el("span", { class: "pill ok", text: "Executed" })
            : proposal.ready
            ? el("span", { class: "pill warn", text: "Ready to execute" })
            : el("span", { class: "pill open", text: "Open" });
          const dots = council.members.map((member) => {
            const on = proposal.approvers.some((a) => a.equals(member));
            return el("span", { class: on ? "dot on" : "dot" }, [el("i"), nameOf(member)]);
          });
          const actions = proposal.executed
            ? []
            : [
                el("button", {
                  text: `Approve as ${role.name}`,
                  onclick: () =>
                    run(`${role.name} approves proposal #${proposal.id}`, async () => {
                      await state.client.approve(state.connection, {
                        payer: state.keys.payer,
                        member: state.keys[role.id],
                        council: chain.councilAddress,
                        id: proposal.id,
                      });
                      return `${role.name} approved proposal #${proposal.id}.`;
                    }),
                }),
                el("button", {
                  class: proposal.ready ? "primary" : "",
                  text: "Execute",
                  onclick: () =>
                    run(`Execute proposal #${proposal.id}`, async () => {
                      await state.client.execute(state.connection, {
                        payer: state.keys.payer,
                        council: chain.councilAddress,
                        id: proposal.id,
                      });
                      return `Proposal #${proposal.id} executed. The pool was updated.`;
                    }),
                }),
              ];
          return el("div", { class: "proposal" }, [
            el("div", { class: "head" }, [
              el("strong", { text: `#${proposal.id}  ${describeAction(proposal.action)}` }),
              status,
            ]),
            el("div", { class: "small muted", text: `Proposed by ${nameOf(proposal.proposer)}` }),
            el("div", { class: "dots" }, [
              ...dots,
              el("span", {
                class: "dot",
                text: `${proposal.approvalCount} of ${council.members.length} approved, needs ${council.threshold}`,
              }),
            ]),
            el("div", { class: "row" }, actions),
          ]);
        })
    );
  };

  const weightInputs = () => Array.from(document.querySelectorAll("#weights input"));
  const renderForm = () => {
    const role = currentRole();
    const kind = document.querySelector("input[name=kind]:checked").value;
    $("fee-form").classList.toggle("hidden", kind !== "fee");
    $("distribution-form").classList.toggle("hidden", kind !== "distribution");
    $("propose").textContent = `Propose as ${role.name}`;
    $("propose-hint").textContent =
      role.id === "mallory" ? "Mallory is not a member. The program will reject this." : "Your own approval is counted.";
    $("fee-hint").textContent = `= ${percent(Number($("fee-bps").value) || 0)}`;

    if (!weightInputs().length) {
      replace(
        $("weights"),
        [50, 30, 20].map((value, i) =>
          el("label", {}, [
            `Validator ${i + 1} `,
            el("input", { type: "number", value: String(value), min: "0", max: "100", step: "1" }),
            " %",
          ])
        )
      );
      weightInputs().forEach((input) => input.addEventListener("input", renderForm));
    }
    const total = weightInputs().reduce((sum, input) => sum + (Number(input.value) || 0), 0);
    $("weights-hint").textContent =
      total === 100
        ? "Total: 100%."
        : `Total: ${total}%. Weights must add up to 100%, so the program will reject this proposal.`;
  };

  const setBusy = (busy) => {
    state.busy = busy;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = busy;
    });
  };

  const render = () => {
    renderRoles();
    renderCouncil();
    renderPool();
    renderForm();
    renderProposals();
    renderLog();
    const connected = Boolean(state.connection);
    const hasCouncil = Boolean(state.chain && state.chain.exists);
    $("propose").disabled = state.busy || !connected || !hasCouncil;
    if (state.busy) setBusy(true);
  };

  // ------------------------------------------------------------ actions
  const refresh = async () => {
    if (!state.connection) return;
    state.chain = await state.client.fetchState(state.connection, state.keys.payer.publicKey);
  };

  // Runs one user action: disables the UI, logs the result or the program error, refreshes.
  const run = async (label, action) => {
    if (state.busy) return false;
    if (!state.connection) {
      addLog("err", "Connect to a validator first.");
      return false;
    }
    setBusy(true);
    let ok = true;
    try {
      const message = await action();
      addLog("ok", message || `${label}: done.`);
    } catch (error) {
      ok = false;
      const detail = error && error.errorName ? `${error.errorName}: ${error.errorMessage}` : String((error && error.message) || error);
      addLog("err", `${label} was rejected. ${detail}`);
    }
    try {
      await refresh();
    } catch (error) {
      addLog("err", `Could not refresh: ${error.message}`);
    }
    state.busy = false;
    setBusy(false);
    render();
    return ok;
  };

  const connect = async () => {
    const url = $("rpc").value.trim();
    setBusy(true);
    $("status").textContent = `Connecting to ${url}…`;
    try {
      const idl = await (await fetch("idl.json")).json();
      const client = window.createStakeCouncilClient(web3, idl);
      const connection = new web3.Connection(url, "confirmed");
      const version = await connection.getVersion();
      const program = await connection.getAccountInfo(client.programId);
      if (!program || !program.executable) {
        throw new Error(
          `the program ${client.programId.toBase58()} is not deployed on this cluster. Start the demo validator with scripts/demo.sh.`
        );
      }
      await client.ensureFunds(connection, state.keys.payer.publicKey);
      state.client = client;
      state.connection = connection;
      await refresh();
      $("status").textContent = `Connected to ${url} (solana-core ${version["solana-core"]}). Program ${client.programId.toBase58()}. Fee payer ${short(state.keys.payer.publicKey)} funded by airdrop.`;
      addLog("info", "Connected.");
    } catch (error) {
      state.connection = null;
      state.chain = null;
      $("status").textContent = `Could not connect: ${error.message}`;
    }
    state.busy = false;
    setBusy(false);
    render();
    return Boolean(state.connection);
  };

  const proposalFromForm = () => {
    const kind = document.querySelector("input[name=kind]:checked").value;
    if (kind === "fee") {
      const feeBps = Math.max(0, Math.min(65535, Math.round(Number($("fee-bps").value) || 0)));
      return { kind: "setFee", feeBps };
    }
    return {
      kind: "setStakeDistribution",
      allocations: weightInputs().map((input, i) => ({
        validator: state.keys.validators[i],
        weightBps: Math.max(0, Math.min(65535, Math.round((Number(input.value) || 0) * 100))),
      })),
    };
  };

  const proposeAs = (roleId, action) => {
    const role = ROLES.find((r) => r.id === roleId);
    return run(`${role.name} proposes`, async () => {
      const { id } = await state.client.propose(state.connection, {
        payer: state.keys.payer,
        proposer: state.keys[roleId],
        council: state.chain.councilAddress,
        action,
      });
      return `${role.name} proposed #${id}. 1 of 3 approvals so far.`;
    });
  };

  // ?autodemo=1 plays the whole flow once, so the page shows real state without clicking.
  const autodemo = async () => {
    if (!(await connect())) return;
    const c = state.client;
    const conn = state.connection;
    const payer = state.keys.payer;
    if (!state.chain.exists) {
      await run("Create council", async () => {
        await c.createCouncil(conn, {
          payer,
          members: MEMBER_IDS.map((id) => state.keys[id].publicKey),
          threshold: THRESHOLD,
          feeBps: 500,
        });
        return "Council created. Its address is now the pool manager.";
      });
    }
    const council = state.chain.councilAddress;
    const first = state.chain.council.proposalCount;
    await proposeAs("alice", { kind: "setFee", feeBps: 250 });
    await run(`Execute proposal #${first}`, () => c.execute(conn, { payer, council, id: first }));
    await run(`Mallory approves proposal #${first}`, () => c.approve(conn, { payer, member: state.keys.mallory, council, id: first }));
    await run(`Bob approves proposal #${first}`, async () => {
      await c.approve(conn, { payer, member: state.keys.bob, council, id: first });
      return `Bob approved proposal #${first}.`;
    });
    await run(`Execute proposal #${first}`, async () => {
      await c.execute(conn, { payer, council, id: first });
      return `Proposal #${first} executed. The pool was updated.`;
    });
    await proposeAs("carol", {
      kind: "setStakeDistribution",
      allocations: [5000, 3000, 2000].map((weightBps, i) => ({ validator: state.keys.validators[i], weightBps })),
    });
    await run(`Bob approves proposal #${first + 1}`, async () => {
      await c.approve(conn, { payer, member: state.keys.bob, council, id: first + 1 });
      return `Bob approved proposal #${first + 1}.`;
    });
    await run(`Execute proposal #${first + 1}`, async () => {
      await c.execute(conn, { payer, council, id: first + 1 });
      return `Proposal #${first + 1} executed. The pool was updated.`;
    });
    await proposeAs("alice", { kind: "setFee", feeBps: 300 });
    state.role = "bob";
    render();
    document.body.setAttribute("data-autodemo", "done");
  };

  // --------------------------------------------------------------- wire
  state.keys = loadKeys();
  if (params.get("rpc")) $("rpc").value = params.get("rpc");

  $("connect").addEventListener("click", connect);
  $("reset").addEventListener("click", () => {
    state.keys = generateKeys();
    saveKeys(state.keys);
    state.chain = null;
    state.log = [];
    replace($("log"), el("li", { class: "muted", text: "Nothing yet." }));
    addLog("info", "New demo wallets generated. Connect to create a new council.");
    if (state.connection) connect();
    else render();
  });
  $("propose").addEventListener("click", () => proposeAs(state.role, proposalFromForm()));
  document.querySelectorAll("input[name=kind]").forEach((input) => input.addEventListener("change", renderForm));
  $("fee-bps").addEventListener("input", renderForm);

  render();
  if (params.get("autodemo") === "1") autodemo();
})();
