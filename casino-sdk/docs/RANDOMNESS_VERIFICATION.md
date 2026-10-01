# Randomness verification (fairness / "verify" UI)

**Audience:** Agents and humans building the provably-fair / verify-randomness section of a casino game iframe.

**Applies to:** Any game that wants to (a) display the VRF words behind a session, (b) re-derive the outcome from them, and (c) show a cryptographic verdict that the words were generated fairly by Verify Network.

---

## Where the randomness comes from

The casino protocol requests randomness from **Verify Network**, an ECVRF network (secp256k1, cipher suite `SECP256K1-SHA256-TAI`). For every request the network publishes, on-chain: the random word, an ECVRF proof, and an EIP-712 signature from the fulfilling node's enclave key. The host app reads and verifies these artifacts; games render the result.

A session can make **several** randomness requests (multi-step games request one per step). Each request is identified by its per-session `nonce`, in request order.

## What the snapshot gives you

Each session item's `raw` block carries the request list:

```ts
raw: {
  gameData?: HexString;
  gameState?: HexString;
  randomness?: HexString;             // first fulfilled word (single-shot games: THE word)
  requestId?: HexString;              // latest request id
  randomnessRequests?: Array<{
    nonce: string;                    // "0", "1", ... in request order
    requestId: HexString;
    randomness?: HexString;           // set once fulfilled
    fulfilled: boolean;
    transactionHash?: HexString;      // VRF fulfillment tx; set once fulfilled
  }>;
  openTransactionHash?: HexString;    // tx that opened the session (the bet)
  settleTransactionHash?: HexString;  // tx that settled the session; set once settled
}
```

The three transaction hashes back real block-explorer `/tx/` links (e.g. basescan). They prove a
transaction exists, not that the randomness is fair — keep the cryptographic verdict below as the
primary fairness signal and treat explorer links as secondary. All three are optional: older hosts
omit them, and sessions projected before the fields existed have none, so always fall back (e.g. to
an address link) when absent.

Use `randomnessRequests` for anything fairness-related; `raw.randomness` / `raw.requestId` are conveniences for single-request games. Re-derive outcomes with your game's `*FromRandomness` mirror of the contract logic and cross-check against the outcome decoded from `gameState`.

## Cryptographic verification

Call the host method (optional — **feature-detect**, older hosts don't have it):

```ts
if (host.getRandomnessVerification) {
  const verification = await host.getRandomnessVerification({ sessionId });
}
```

Returns `RandomnessVerificationV1`:

```ts
{
  supported: boolean;        // false on environments without Verify Network (e.g. local dev)
  chainId: number;
  routerAddress?: HexString; // Verify Network router the artifacts were read from
  requests: Array<RandomnessRequestV1 & {
    artifacts?: {            // raw on-chain artifacts, for independent re-verification
      randomness: HexString;
      proof: [HexString, HexString, HexString, HexString];      // ECVRF [gammaX, gammaY, c, s]
      uPoint: [HexString, HexString];
      vComponents: [HexString, HexString, HexString, HexString];
      enclaveSignature: HexString;                               // EIP-712 signature
      alpha: HexString;                                          // VRF input == requestId
    };
    fulfiller?: HexString;                 // assigned enclave address
    nodePublicKey?: [HexString, HexString]; // node's registered secp256k1 key [x, y]
    checks?: {
      vrfProofValid: boolean;              // ECVRF proof verifies for (publicKey, requestId)
      vrfBetaMatchesRandomness: boolean;   // proof output == published randomness
      fastVerifyComponentsMatch: boolean;  // same check the chain ran at fulfillment
      enclaveSignatureValid: boolean;      // EIP-712 signature recovers
      signerMatchesFulfiller: boolean;     // signer == assigned enclave
    };
    valid?: boolean;                       // all five checks passed
  }>;
}
```

### Rendering rules

- `supported === false` → hide or grey out the verify section ("not available on this network"). Do not treat it as a failure.
- A request with `fulfilled: false` and no `checks` → still pending; render as waiting.
- A **fulfilled** request with `checks` absent → the host could not reach the chain; offer a retry. This is "could not verify", **not** "invalid".
- `valid === false` → render prominently as a failed verification, per failing check.
- Verification is on-demand and does a few RPC reads per request — call it when the user opens the verify view, not on every snapshot.

### Trust model

The host verifies client-side (in the user's browser) against on-chain data: it reads the artifacts and the node's registered public key from the Verify Network router and runs the ECVRF + EIP-712 checks locally. The `artifacts`, `fulfiller`, `nodePublicKey`, and `routerAddress` fields are returned precisely so anyone can repeat the verification without trusting the host's verdict — the inputs are all public on-chain state keyed by `requestId`.
