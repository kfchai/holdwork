/**
 * Deploy HoldworkEscrow to Base Sepolia (default) or Base mainnet with the pilot arbiter wallet.
 *
 *   npx tsx scripts/deploy-escrow.ts                 # Base Sepolia, cap 50 USDC
 *   HOLDWORK_CHAIN=base MAX_PRICE=50 npx tsx scripts/deploy-escrow.ts
 *
 * Reads the key from .wallet/arbiter-testnet.json. Owner, arbiter and fee account all start as
 * that wallet; the owner moves to a multisig later with setOwner/setFeeAccount.
 * Writes the deployment record to deployments/<chain>.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseUnits, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const chainName = process.env.HOLDWORK_CHAIN ?? 'base-sepolia';
const chain = chainName === 'base' ? base : baseSepolia;
const USDC: Record<string, Hex> = {
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};
const maxPrice = parseUnits(process.env.MAX_PRICE ?? '50', 6);

const wallet = JSON.parse(readFileSync('.wallet/arbiter-testnet.json', 'utf8')) as { privateKey: Hex; address: Hex };
const account = privateKeyToAccount(wallet.privateKey);
const abi = JSON.parse(readFileSync('build/HoldworkEscrow.abi.json', 'utf8')) as Abi;
const bytecode = ('0x' + readFileSync('build/HoldworkEscrow.bin', 'utf8').trim()) as Hex;

const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ chain, account, transport: http() });

const balance = await publicClient.getBalance({ address: account.address });
console.log(`deployer ${account.address} on ${chain.name}, balance ${Number(balance) / 1e18} ETH`);
if (balance === 0n) throw new Error('deployer has no gas; fund it first');

const hash = await walletClient.deployContract({
  abi, bytecode,
  args: [USDC[chainName], account.address, account.address, account.address, maxPrice],
});
console.log('deploy tx', hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (!receipt.contractAddress) throw new Error('no contract address in receipt');
console.log('HoldworkEscrow deployed at', receipt.contractAddress);

mkdirSync('deployments', { recursive: true });
writeFileSync(`deployments/${chainName}.json`, JSON.stringify({
  chain: chainName, chainId: chain.id, address: receipt.contractAddress, usdc: USDC[chainName],
  owner: account.address, arbiter: account.address, feeAccount: account.address,
  maxPrice: maxPrice.toString(), deployTx: hash, block: receipt.blockNumber.toString(), deployedAt: new Date().toISOString(),
}, null, 2));
console.log(`recorded in deployments/${chainName}.json`);
