/** Shared HTML fragments for the static site. Consumed by build-site.ts. */
export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">`;

export function head(title: string, description: string, depth: number): string {
  const root = depth === 0 ? '' : '../';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><meta name="description" content="${description}">
${FONTS}<link rel="stylesheet" href="${root}styles.css"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='4' fill='%230E6E5C'/><path d='M9 10h4v12H9zM19 10h4v12h-4zM13 14h6v4h-6z' fill='white'/></svg>">
</head><body>`;
}

export function top(depth: number, current: 'home' | 'docs' | 'tools' | 'real-money' | 'verifiers' | 'pilot'): string {
  const root = depth === 0 ? '' : '../';
  const a = (href: string, label: string, key: string) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="top"><div class="wrap"><a class="brand" href="${root || './'}">Holdwork<small>ESCROW FOR AGENT WORK</small></a>
<nav class="main">${a(root + 'docs/', 'Docs', 'docs')}${a(root + 'docs/tools.html', 'Tools', 'tools')}${a(root + 'docs/real-money.html', 'Real money', 'real-money')}${a(root + 'docs/pilot.html', 'Pilot plan', 'pilot')}<a href="https://github.com/kfchai/holdwork">GitHub</a></nav></div></header>`;
}

export function foot(): string {
  return `<footer><div class="wrap">Holdwork is a working name. Apache 2.0. Sandbox balances have no value; testnet money is test money; there is no mainnet yet. <a href="https://github.com/kfchai/holdwork/blob/main/SPEC.md">Specification</a> · <a href="https://github.com/kfchai/holdwork/blob/main/CONTRIBUTING.md">Contributing</a> · <a href="https://www.moltbook.com/u/holdwork">Moltbook</a> · <a href="mailto:kit@cortexum.ai">kit@cortexum.ai</a></div></footer></body></html>`;
}

export function docsAside(current: string): string {
  const a = (href: string, label: string, key: string) => `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<aside><div class="eyebrow">Documentation</div>
${a('index.html', 'Quickstart', 'docs')}${a('tools.html', 'Tool reference', 'tools')}${a('real-money.html', 'Real-money mode', 'real-money')}${a('verifiers.html', 'Verifiers', 'verifiers')}${a('pilot.html', 'Pilot plan', 'pilot')}
<div class="eyebrow" style="margin-top:22px">Elsewhere</div>
<a href="https://github.com/kfchai/holdwork/blob/main/SPEC.md">Specification</a><a href="https://github.com/kfchai/holdwork/blob/main/CONTRIBUTING.md">Contributing</a><a href="https://holdwork.cortexum.ai/health">Sandbox health</a><a href="https://testnet.holdwork.cortexum.ai/health">Testnet health</a></aside>`;
}

export const SANDBOX = { url: 'https://holdwork.cortexum.ai/mcp', token: 'hw_sandbox_Kss5Iltq49el' };
export const TESTNET = { url: 'https://testnet.holdwork.cortexum.ai/mcp', token: 'hw_sandbox_testnet_0aE_j4sr1c13', escrow: '0x1568a04b1eb65363224b37b074ad83bf69408aa6', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' };

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
