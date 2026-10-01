// Host-side implementation of `getRandomnessVerification` for the simulator —
// the piece the game's "provably fair" dialog calls (feature-detected) to get
// a cryptographic verdict on each VRF fulfillment. Mirrors what the production
// host does: read the artifacts + node key from the Verify Network router and
// run the ECVRF + EIP-712 checks locally, per docs/RANDOMNESS_VERIFICATION.md.
//
// The ECVRF verify below replicates @kenshi.io/node-ecvrf's
// ECVRF-SECP256K1-SHA256-TAI implementation (suite byte 0xfe, try-and-increment
// hash-to-curve with a fixed 0x02 candidate prefix, 16-byte truncated challenge)
// using @noble/curves + @noble/hashes, because node-ecvrf depends on Node's
// `crypto` module and cannot run in the simulator's browser context.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type { RandomnessRequestVerificationV1, RandomnessVerificationV1 } from '@chain/casino-sdk';

type Point = InstanceType<typeof secp256k1.ProjectivePoint>;

const SUITE = 0xfe; // ECVRF-SECP256K1-SHA256-TAI

const hostRouterAbi = [
  {
    inputs: [],
    name: 'router',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const routerViewsAbi = [
  {
    inputs: [{ name: 'requestId', type: 'bytes32' }],
    name: 'requestIdToFulfiller',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'node', type: 'address' }],
    name: 'getAddressToPublicKey',
    outputs: [{ name: '', type: 'uint256[2]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// The router persists only the fulfillment COMMITMENT (for the challenge
// game); the full proof artifacts are published in this event and its
// transaction calldata. Reading the event is the canonical artifact source.
const randomnessFulfilledEvent = {
  anonymous: false,
  inputs: [
    { indexed: true, name: 'requestId', type: 'bytes32' },
    { indexed: false, name: 'randomness', type: 'bytes32' },
    { indexed: false, name: 'proof', type: 'uint256[4]' },
    { indexed: false, name: 'uPoint', type: 'uint256[2]' },
    { indexed: false, name: 'vComponents', type: 'uint256[4]' },
    { indexed: false, name: 'enclaveSignature', type: 'bytes' },
  ],
  name: 'RandomnessFulfilled',
  type: 'event',
} as const;

function toBytes32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number((v >> BigInt((31 - i) * 8)) & 0xffn);
  }
  return out;
}

function hexToBytes32(hex: Hex): Uint8Array {
  return toBytes32(BigInt(hex));
}

function toHex32(v: bigint): Hex {
  return `0x${v.toString(16).padStart(64, '0')}` as Hex;
}

function concatBytes(...parts: (number | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') flat.push(p);
    else flat.push(...p);
  }
  return Uint8Array.from(flat);
}

/** Compressed SEC1 encoding — node-ecvrf's point_to_string. */
function pointToString(p: Point): Uint8Array {
  return p.toRawBytes(true);
}

/** node-ecvrf's hash_to_curve_try_and_increment: fixed 0x02 candidate prefix. */
function hashToCurveTAI(publicKey: Point, alpha: Uint8Array): Point | null {
  const pkString = pointToString(publicKey);
  for (let ctr = 0; ctr < 256; ctr++) {
    const digest = sha256(concatBytes(SUITE, 0x01, pkString, alpha, ctr, 0x00));
    try {
      const candidate = secp256k1.ProjectivePoint.fromHex(concatBytes(0x02, digest));
      candidate.assertValidity();
      return candidate;
    } catch {
      // Not a curve point for this ctr — increment and retry.
    }
  }
  return null;
}

/** node-ecvrf's hash_points: 16-byte truncated challenge. */
function hashPoints(...points: Point[]): bigint {
  const digest = sha256(concatBytes(SUITE, 0x02, ...points.map(pointToString), 0x00));
  let c = 0n;
  for (let i = 0; i < 16; i++) c = (c << 8n) | BigInt(digest[i]);
  return c;
}

/** ECVRF beta (the random output) from Gamma — node-ecvrf's proof_to_hash. */
function proofToHash(gamma: Point): Uint8Array {
  return sha256(concatBytes(SUITE, 0x03, pointToString(gamma), 0x00));
}

type EcvrfVerdict = {
  vrfProofValid: boolean;
  vrfBetaMatchesRandomness: boolean;
  fastVerifyComponentsMatch: boolean;
};

function verifyEcvrf(input: {
  nodePublicKey: readonly [bigint, bigint];
  proof: readonly [bigint, bigint, bigint, bigint];
  uPoint: readonly [bigint, bigint];
  vComponents: readonly [bigint, bigint, bigint, bigint];
  alpha: Uint8Array;
  randomness: bigint;
}): EcvrfVerdict {
  const invalid: EcvrfVerdict = {
    vrfProofValid: false,
    vrfBetaMatchesRandomness: false,
    fastVerifyComponentsMatch: false,
  };
  try {
    const Y = secp256k1.ProjectivePoint.fromAffine({
      x: input.nodePublicKey[0],
      y: input.nodePublicKey[1],
    });
    Y.assertValidity();
    const gamma = secp256k1.ProjectivePoint.fromAffine({
      x: input.proof[0],
      y: input.proof[1],
    });
    gamma.assertValidity();
    const c = input.proof[2];
    const s = input.proof[3];
    if (s >= secp256k1.CURVE.n) return invalid;

    // Degenerate scalars can't occur in a well-formed proof; reject instead of
    // special-casing point-at-infinity arithmetic. NOTE: use multiply(), NOT
    // multiplyUnsafe() — @noble/curves 1.9.1's multiplyUnsafe returns wrong
    // results for some scalars on points with cached precomputes (BASE).
    if (c === 0n || s === 0n) return invalid;

    const H = hashToCurveTAI(Y, input.alpha);
    if (!H) return invalid;

    // U = s·B − c·Y ; V = s·H − c·Γ
    const U = secp256k1.ProjectivePoint.BASE.multiply(s).add(Y.multiply(c).negate());
    const sH = H.multiply(s);
    const cGamma = gamma.multiply(c);
    const V = sH.add(cGamma.negate());

    const cPrime = hashPoints(H, gamma, U, V);
    const vrfProofValid = cPrime === c;

    const beta = proofToHash(gamma);
    let betaValue = 0n;
    for (const b of beta) betaValue = (betaValue << 8n) | BigInt(b);
    const vrfBetaMatchesRandomness = betaValue === input.randomness;

    const uAff = U.toAffine();
    const sHAff = sH.toAffine();
    const cGammaAff = cGamma.toAffine();
    const fastVerifyComponentsMatch =
      uAff.x === input.uPoint[0] &&
      uAff.y === input.uPoint[1] &&
      sHAff.x === input.vComponents[0] &&
      sHAff.y === input.vComponents[1] &&
      cGammaAff.x === input.vComponents[2] &&
      cGammaAff.y === input.vComponents[3];

    return { vrfProofValid, vrfBetaMatchesRandomness, fastVerifyComponentsMatch };
  } catch {
    return invalid;
  }
}

/**
 * Verify every VRF request of a session against on-chain router state.
 * Throws when the chain (or the router address) is unreachable — the game
 * renders that as "could not verify, retry", per the SDK doc. A single
 * request whose reads fail comes back with `checks` absent instead.
 */
export async function verifySessionRandomness(input: {
  publicClient: PublicClient;
  chainId: number;
  /** LocalCasinoHost address — its `router()` getter locates the artifacts. */
  proxy: Address;
  requests: Array<{
    nonce: string;
    requestId: string;
    randomness?: string;
    fulfilled: boolean;
    transactionHash?: string;
  }>;
}): Promise<RandomnessVerificationV1> {
  const { publicClient, chainId, proxy, requests } = input;

  const router = (await publicClient.readContract({
    address: proxy,
    abi: hostRouterAbi,
    functionName: 'router',
  })) as Address;
  if (!router || router === zeroAddress) {
    return { supported: false, chainId, requests: [] };
  }

  const verified: RandomnessRequestVerificationV1[] = [];
  for (const req of requests) {
    const base: RandomnessRequestVerificationV1 = {
      nonce: req.nonce,
      requestId: req.requestId as Hex,
      randomness: req.randomness as Hex | undefined,
      fulfilled: req.fulfilled,
      transactionHash: req.transactionHash as Hex | undefined,
    };
    if (!req.fulfilled) {
      verified.push(base);
      continue;
    }
    try {
      const requestId = req.requestId as Hex;
      const [fulfillLogs, fulfiller] = await Promise.all([
        publicClient.getLogs({
          address: router,
          event: randomnessFulfilledEvent,
          args: { requestId },
          fromBlock: 0n,
        }),
        publicClient.readContract({
          address: router,
          abi: routerViewsAbi,
          functionName: 'requestIdToFulfiller',
          args: [requestId],
        }) as Promise<Address>,
      ]);
      const log = fulfillLogs[fulfillLogs.length - 1];
      if (!log) {
        // Marked fulfilled but the event isn't visible yet (indexing lag) —
        // "could not verify", retryable.
        verified.push(base);
        continue;
      }
      const randomness = log.args.randomness as Hex;
      const proof = log.args.proof as readonly [bigint, bigint, bigint, bigint];
      const uPoint = log.args.uPoint as readonly [bigint, bigint];
      const vComponents = log.args.vComponents as readonly [bigint, bigint, bigint, bigint];
      const enclaveSignature = log.args.enclaveSignature as Hex;
      // The VRF input is the request id itself (alpha == requestId on-chain).
      const alpha = requestId;
      const nodePublicKey = (await publicClient.readContract({
        address: router,
        abi: routerViewsAbi,
        functionName: 'getAddressToPublicKey',
        args: [fulfiller],
      })) as readonly [bigint, bigint];

      const ecvrf = verifyEcvrf({
        nodePublicKey,
        proof,
        uPoint,
        vComponents,
        alpha: hexToBytes32(alpha),
        randomness: BigInt(randomness),
      });

      // EIP-712 enclave signature over the proof commitment — the mirror of
      // what local-verify-network's fulfillLocalVrfRequest signs.
      const proofCommitment = keccak256(
        encodeAbiParameters(
          [
            { name: 'proof', type: 'uint256[4]' },
            { name: 'uPoint', type: 'uint256[2]' },
            { name: 'vComponents', type: 'uint256[4]' },
          ],
          [[...proof], [...uPoint], [...vComponents]],
        ),
      );
      let signer: Address | null = null;
      try {
        signer = await recoverTypedDataAddress({
          domain: {
            name: 'VerifyNetworkVRF',
            version: '1',
            chainId,
            verifyingContract: router,
          },
          types: {
            Fulfillment: [
              { name: 'requestId', type: 'bytes32' },
              { name: 'proofCommitment', type: 'bytes32' },
            ],
          },
          primaryType: 'Fulfillment',
          message: { requestId, proofCommitment },
          signature: enclaveSignature,
        });
      } catch {
        signer = null;
      }

      const checks = {
        ...ecvrf,
        enclaveSignatureValid: signer !== null,
        signerMatchesFulfiller: signer !== null && signer.toLowerCase() === fulfiller.toLowerCase(),
      };
      verified.push({
        ...base,
        transactionHash: base.transactionHash ?? log.transactionHash ?? undefined,
        artifacts: {
          randomness,
          proof: [toHex32(proof[0]), toHex32(proof[1]), toHex32(proof[2]), toHex32(proof[3])],
          uPoint: [toHex32(uPoint[0]), toHex32(uPoint[1])],
          vComponents: [
            toHex32(vComponents[0]),
            toHex32(vComponents[1]),
            toHex32(vComponents[2]),
            toHex32(vComponents[3]),
          ],
          enclaveSignature,
          alpha,
        },
        fulfiller,
        nodePublicKey: [toHex32(nodePublicKey[0]), toHex32(nodePublicKey[1])],
        checks,
        valid: Object.values(checks).every(Boolean),
      });
    } catch {
      // Reads failed for this request only — fulfilled + no checks renders as
      // "could not verify" with a retry, NOT as invalid.
      verified.push(base);
    }
  }

  return { supported: true, chainId, routerAddress: router, requests: verified };
}
