// Compiles developer-dropped .sol files in contracts/ (the two harness infra
// sources are excluded) with the bundled solc, deploys every contract that
// implements ICasinoGameV2, registers it on the local host and keeps watching
// the folder so new or edited files go live without a restart.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import type { Abi, Address, Hex } from 'viem';
import solc from 'solc';

const INFRA_SOURCES = new Set(['LocalCasinoHost.sol', 'LocalTestToken.sol']);
const GAME_INTERFACE_FUNCTIONS = ['quoteCaps', 'onPlayerAction'] as const;
const WATCH_DEBOUNCE_MS = 300;

export type DeployedGame = { name: string; address: Address; sourceFile: string };

export type GameContractsWatcherOptions = {
  contractsDir: string;
  sdkRoot: string;
  deployGame: (abi: Abi, bytecode: Hex) => Promise<Address>;
  registerGame: (address: Address, name: string) => Promise<void>;
  onGamesChanged: (games: DeployedGame[]) => void;
};

type CompiledContract = { name: string; abi: Abi; bytecode: Hex; hasConstructorArgs: boolean };

type SolcOutput = {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
};

function isGame(abi: Abi): boolean {
  return GAME_INTERFACE_FUNCTIONS.every(name =>
    abi.some(entry => entry.type === 'function' && entry.name === name),
  );
}

function compileFile(
  contractsDir: string,
  sdkRoot: string,
  file: string,
  source: string,
): CompiledContract[] {
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const findImports = (importPath: string) => {
    const sibling = resolve(contractsDir, importPath);
    if (sibling.startsWith(contractsDir) && existsSync(sibling)) {
      return { contents: readFileSync(sibling, 'utf8') };
    }
    // SDK-relative imports like ../../solidity/ICasinoGameV2.sol.
    const fromSdk = resolve(sdkRoot, importPath.replace(/^(\.\.\/)+/, ''));
    if (existsSync(fromSdk)) return { contents: readFileSync(fromSdk, 'utf8') };
    // Workspace-relative imports used by games kept outside the SDK package.
    const fromWorkspace = resolve(sdkRoot, '..', importPath.replace(/^(\.\.\/)+/, ''));
    if (existsSync(fromWorkspace)) return { contents: readFileSync(fromWorkspace, 'utf8') };
    return { error: `Import not found: ${importPath}` };
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports }),
  ) as SolcOutput;
  const errors = (output.errors ?? []).filter(error => error.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `compilation failed\n${errors.map(error => error.formattedMessage).join('\n')}`,
    );
  }

  return Object.entries(output.contracts?.[file] ?? {})
    .filter(([, contract]) => contract.evm.bytecode.object.length > 0)
    .map(([name, contract]) => {
      const constructor = contract.abi.find(entry => entry.type === 'constructor');
      return {
        name,
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}` as Hex,
        hasConstructorArgs: constructor !== undefined && constructor.inputs.length > 0,
      };
    });
}

async function deployGamesFromFile(
  options: GameContractsWatcherOptions,
  file: string,
  source: string,
): Promise<DeployedGame[]> {
  const contracts = compileFile(options.contractsDir, options.sdkRoot, file, source);
  const gameContracts = contracts.filter(contract => isGame(contract.abi));
  if (gameContracts.length === 0) {
    console.warn(
      `[local-node] ${file}: no deployable contract implements ICasinoGameV2 ` +
        `(${GAME_INTERFACE_FUNCTIONS.join(', ')}) — nothing deployed`,
    );
    return [];
  }

  const games: DeployedGame[] = [];
  for (const contract of gameContracts) {
    if (contract.hasConstructorArgs) {
      console.warn(
        `[local-node] ${file}: ${contract.name} needs constructor arguments — deploy it ` +
          'manually and paste the address into the setup panel',
      );
      continue;
    }
    const address = await options.deployGame(contract.abi, contract.bytecode);
    await options.registerGame(address, contract.name);
    games.push({ name: contract.name, address, sourceFile: file });
    console.log(`[local-node] ${file}: deployed ${contract.name} at ${address}`);
  }
  return games;
}

/** Resolves after the initial compile-and-deploy scan; keeps watching afterwards. */
export async function watchGameContracts(options: GameContractsWatcherOptions): Promise<void> {
  const deployed = new Map<string, { hash: string; games: DeployedGame[] }>();

  const listSources = () =>
    readdirSync(options.contractsDir)
      .filter(file => file.endsWith('.sol') && !INFRA_SOURCES.has(file))
      .sort();

  const currentGames = () =>
    [...deployed.values()]
      .flatMap(entry => entry.games)
      .sort((a, b) => a.name.localeCompare(b.name));

  const sync = async () => {
    let changed = false;
    const files = listSources();
    for (const stale of [...deployed.keys()].filter(file => !files.includes(file))) {
      deployed.delete(stale);
      changed = true;
      console.log(`[local-node] ${stale} removed — dropping its games from the list`);
    }
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(resolve(options.contractsDir, file), 'utf8');
      } catch {
        continue; // half-written file mid-copy; the next watch event retries
      }
      const hash = createHash('sha256').update(source).digest('hex');
      if (deployed.get(file)?.hash === hash) continue;
      try {
        deployed.set(file, { hash, games: await deployGamesFromFile(options, file, source) });
        changed = true;
      } catch (error) {
        console.error(
          `[local-node] ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Remember the broken revision (keeping the last good deployment) so it
        // is not recompiled on every unrelated watch event.
        deployed.set(file, { hash, games: deployed.get(file)?.games ?? [] });
      }
    }
    if (changed) options.onGamesChanged(currentGames());
  };

  await sync();

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  watch(options.contractsDir, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      queue = queue.then(sync);
    }, WATCH_DEBOUNCE_MS);
  });
  console.log(
    `[local-node] Watching ${options.contractsDir} — drop in a .sol implementing ` +
      'ICasinoGameV2 and it compiles, deploys and registers automatically.',
  );
}
