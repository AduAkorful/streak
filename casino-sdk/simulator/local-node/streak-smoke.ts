import { readFileSync } from 'node:fs';

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { localCasinoHostAbi, localTestTokenAbi } from '../src/local-node/artifacts.ts';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!PRIVATE_KEY) throw new Error('DEPLOYER_PRIVATE_KEY is required for the smoke run.');

const deployment = JSON.parse(
  readFileSync(new URL('./deployed.json', import.meta.url), 'utf8'),
) as {
  chainId: number;
  host: Address;
  vault: Address;
  token: Address;
  games: Array<{ name: string; address: Address }>;
};
const streak = deployment.games.find(game => game.name === 'StreakGame');
if (!streak) throw new Error('StreakGame is not present in deployed.json.');

const chain = defineChain({
  id: deployment.chainId,
  name: `Local chain ${deployment.chainId}`,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 200 });
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

const gameData = encodeAbiParameters(
  [{ type: 'uint8' }, { type: 'uint8' }],
  [0, 0],
);
const cashoutAction = encodeAbiParameters(
  [{ type: 'uint8' }, { type: 'uint8' }],
  [0, 0],
);
const continueSuitAction = encodeAbiParameters(
  [{ type: 'uint8' }, { type: 'uint8' }],
  [1, 1],
);

type Session = {
  phase: number;
  gameState: Hex;
};

async function session(sessionId: bigint): Promise<Session> {
  return (await publicClient.readContract({
    address: deployment.host,
    abi: localCasinoHostAbi,
    functionName: 'getSession',
    args: [sessionId],
  })) as unknown as Session;
}

async function waitForTerminal(sessionId: bigint): Promise<Session> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await session(sessionId);
    if (current.phase >= 3) return current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Session ${sessionId} did not settle within 60 seconds.`);
}

async function waitForActionOrTerminal(sessionId: bigint): Promise<Session> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await session(sessionId);
    if (current.phase === 2 || current.phase >= 3) return current;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Session ${sessionId} did not advance within 60 seconds.`);
}

async function approveHost(): Promise<void> {
  const hash = await walletClient.writeContract({
    address: deployment.token,
    abi: localTestTokenAbi,
    functionName: 'approve',
    args: [deployment.host, maxUint256],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function tokenBalance(): Promise<bigint> {
  return (await publicClient.readContract({
    address: deployment.token,
    abi: localTestTokenAbi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
}

async function open(wager: bigint): Promise<bigint> {
  const hash = await walletClient.writeContract({
    address: deployment.host,
    abi: localCasinoHostAbi,
    functionName: 'openSession',
    args: [streak!.address, deployment.vault, wager, gameData, '0x'],
    account,
    chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return (await publicClient.readContract({
    address: deployment.host,
    abi: localCasinoHostAbi,
    functionName: 'currentSessionId',
  })) as bigint;
}

async function main(): Promise<void> {
  await approveHost();

  let settledLoss = false;
  let settledWin = false;
  for (let attempt = 0; attempt < 12 && (!settledLoss || !settledWin); attempt += 1) {
    const before = await tokenBalance();
    const sessionId = await open(parseEther('1'));
    let result = await waitForActionOrTerminal(sessionId);
    if (result.phase === 2) {
      const hash = await walletClient.writeContract({
        address: deployment.host,
        abi: localCasinoHostAbi,
        functionName: 'submitAction',
        args: [sessionId, cashoutAction, '0x'],
        account,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      result = await waitForTerminal(sessionId);
    }
    if (result.phase !== 3) throw new Error(`Unexpected terminal phase ${result.phase}.`);
    if (result.gameState === '0x') throw new Error('Settled session has empty game state.');
    const after = await tokenBalance();
    if (after < before) settledLoss = true;
    else settledWin = true;
  }
  if (!settledLoss || !settledWin) {
    throw new Error('Did not observe both a VRF loss and a VRF win in 12 sessions.');
  }

  let cashoutPassed = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const before = await tokenBalance();
    const sessionId = await open(parseEther('1'));
    for (let poll = 0; poll < 300; poll += 1) {
      const current = await session(sessionId);
      if (current.phase === 2) {
        const hash = await walletClient.writeContract({
          address: deployment.host,
          abi: localCasinoHostAbi,
          functionName: 'submitAction',
          args: [sessionId, cashoutAction, '0x'],
          account,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        const settled = await waitForTerminal(sessionId);
        const after = await tokenBalance();
        if (settled.phase === 3 && after > before - parseEther('1')) {
          console.log(`cash-out flow passed: session ${sessionId}`);
          cashoutPassed = true;
          break;
        }
        throw new Error('Cash-out flow settled without a payout.');
      }
      if (current.phase >= 3) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (cashoutPassed) break;
  }
  if (!cashoutPassed) {
    throw new Error('Did not observe a successful hit followed by player cash-out.');
  }

  let continuationPassed = false;
  for (let attempt = 0; attempt < 12 && !continuationPassed; attempt += 1) {
    const sessionId = await open(parseEther('1'));
    for (let poll = 0; poll < 300; poll += 1) {
      const current = await session(sessionId);
      if (current.phase === 2) {
        const hash = await walletClient.writeContract({
          address: deployment.host,
          abi: localCasinoHostAbi,
          functionName: 'submitAction',
          args: [sessionId, continueSuitAction, '0x'],
          account,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        for (let nextPoll = 0; nextPoll < 300; nextPoll += 1) {
          const next = await session(sessionId);
          if (next.phase === 3) {
            continuationPassed = true;
            break;
          }
          if (next.phase === 2) {
            const cashoutHash = await walletClient.writeContract({
              address: deployment.host,
              abi: localCasinoHostAbi,
              functionName: 'submitAction',
              args: [sessionId, cashoutAction, '0x'],
              account,
              chain,
            });
            await publicClient.waitForTransactionReceipt({ hash: cashoutHash });
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        break;
      }
      if (current.phase >= 3) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (!continuationPassed) throw new Error('Did not observe a successful continue action.');

  const malformed = '0x00' as Hex;
  try {
    await publicClient.simulateContract({
      address: deployment.host,
      abi: localCasinoHostAbi,
      functionName: 'openSession',
      args: [streak.address, deployment.vault, parseEther('1'), malformed, '0x'],
      account,
    });
    throw new Error('Malformed gameData was accepted.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Malformed gameData was accepted.') throw error;
  }

  console.log('Streak smoke flows passed: loss, win, cash-out, malformed gameData.');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
