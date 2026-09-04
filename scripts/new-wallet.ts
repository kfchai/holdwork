/**
 * Generate an EVM wallet and store it in .wallet/<name>.json (gitignored).
 * Prints the address only. The private key never goes to stdout.
 *
 *   npx tsx scripts/new-wallet.ts arbiter-testnet
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error('usage: new-wallet.ts <name>  (lowercase letters, digits, dashes)');
mkdirSync('.wallet', { recursive: true });
const path = `.wallet/${name}.json`;
if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite a key`);

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
writeFileSync(path, JSON.stringify({ name, address: account.address, privateKey, createdAt: new Date().toISOString(), purpose: 'Holdwork pilot arbiter (testnet first). Hot key. Not the treasury.' }, null, 2), { mode: 0o600 });

console.log(`wallet "${name}" created`);
console.log(`address: ${account.address}`);
console.log(`key file: ${path} (gitignored, do not copy into chat, tickets, or the repo)`);
