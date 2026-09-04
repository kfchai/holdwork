/** Compile contracts/HoldworkEscrow.sol with solc-js and write ABI + bytecode to build/. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import solc from 'solc';

const source = readFileSync('contracts/HoldworkEscrow.sol', 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'HoldworkEscrow.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.gasEstimates'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
for (const e of out.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const c = out.contracts['HoldworkEscrow.sol'].HoldworkEscrow;
mkdirSync('build', { recursive: true });
writeFileSync('build/HoldworkEscrow.abi.json', JSON.stringify(c.abi, null, 2));
writeFileSync('build/HoldworkEscrow.bin', c.evm.bytecode.object);
console.log(`compiled: ${c.abi.length} ABI entries, ${c.evm.bytecode.object.length / 2} bytes of bytecode`);
