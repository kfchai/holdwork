/**
 * On-chain escrow tests against an in-process EVM. Mirrors the engine's money rules:
 * conservation on every path, buyer-signed release, arbiter only on disputes, timeouts open to anyone.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { keccak256, toHex, parseUnits, type Hex } from 'viem';

const U = (n: string) => parseUnits(n, 6);
const id = (s: string): Hex => keccak256(toHex(s));

describe('HoldworkEscrow', async () => {
  const { viem, networkHelpers } = await network.create();
  const [owner, buyer, seller, stranger] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  let usdc: Awaited<ReturnType<typeof viem.deployContract<'MockUSDC'>>>;
  let escrow: Awaited<ReturnType<typeof viem.deployContract<'HoldworkEscrow'>>>;
  const feeAccount = owner.account.address;

  const bal = async (a: Hex) => usdc.read.balanceOf([a]);
  const now = async () => BigInt((await publicClient.getBlock()).timestamp);

  before(async () => {
    usdc = await viem.deployContract('MockUSDC');
    escrow = await viem.deployContract('HoldworkEscrow', [usdc.address, owner.account.address, owner.account.address, feeAccount, U('50')]);
    for (const w of [buyer, seller]) {
      await usdc.write.mint([w.account.address, U('1000')]);
      await usdc.write.approve([escrow.address, U('1000000')], { account: w.account });
    }
  });

  async function openAndCommit(cid: Hex, price = '20', stake = '1') {
    const t = await now();
    await escrow.write.open([cid, U(price), t + 3600n], { account: buyer.account });
    await escrow.write.commit([cid, U(stake), t + 7200n], { account: seller.account });
  }

  it('buyer accept releases share plus stake to seller, refund to buyer, fee to fee account', async () => {
    const cid = id('c1');
    const [b0, s0, f0] = [await bal(buyer.account.address), await bal(seller.account.address), await bal(feeAccount)];
    await openAndCommit(cid);
    assert.equal(await bal(escrow.address), U('21'));
    await escrow.write.accept([cid, U('10')], { account: buyer.account }); // half quality
    assert.equal(await bal(escrow.address), 0n);
    assert.equal(await bal(seller.account.address), s0 - U('1') + U('10') - U('0.10') + U('1'));
    assert.equal(await bal(buyer.account.address), b0 - U('20') + U('10'));
    assert.equal(await bal(feeAccount), f0 + U('0.10'));
  });

  it('only the buyer can accept, and only once', async () => {
    const cid = id('c2');
    await openAndCommit(cid);
    await assert.rejects(escrow.write.accept([cid, U('20')], { account: seller.account }));
    await assert.rejects(escrow.write.accept([cid, U('20')], { account: owner.account })); // arbiter cannot accept
    await escrow.write.accept([cid, U('20')], { account: buyer.account });
    await assert.rejects(escrow.write.accept([cid, U('20')], { account: buyer.account }));
  });

  it('arbiter cannot settle a committed contract before the assessment window', async () => {
    const cid = id('c3');
    await openAndCommit(cid);
    await assert.rejects(escrow.write.settle([cid, U('20'), 0n, 0n, U('1'), 0n, 0n, 0n, 0n], { account: owner.account }));
  });

  it('dispute then arbiter settle with an exact split; wrong sums revert', async () => {
    const cid = id('c4');
    const e0 = await bal(escrow.address); // earlier tests leave committed contracts funded
    await openAndCommit(cid);
    await escrow.write.dispute([cid, U('2')], { account: buyer.account });
    assert.equal(await bal(escrow.address), e0 + U('23'));
    // stranger cannot settle
    await assert.rejects(escrow.write.settle([cid, U('1.95'), U('0.05'), U('18'), U('0.85'), 0n, U('0.15'), U('2'), 0n], { account: stranger.account }));
    // split must sum exactly: price short, stake over, bond under
    await assert.rejects(escrow.write.settle([cid, U('2'), U('0.05'), U('17'), U('0.85'), 0n, U('0.15'), U('2'), 0n], { account: owner.account }));
    await assert.rejects(escrow.write.settle([cid, U('1.95'), U('0.05'), U('18'), U('1'), U('0.5'), 0n, U('2'), 0n], { account: owner.account }));
    await assert.rejects(escrow.write.settle([cid, U('1.95'), U('0.05'), U('18'), U('0.85'), 0n, U('0.15'), U('1'), 0n], { account: owner.account }));
    const [b0, s0, f0] = [await bal(buyer.account.address), await bal(seller.account.address), await bal(feeAccount)];
    // buyer vindicated: seller gets 1.95 net of 0.05 fee, stake pays 0.15 verifier fees to the fee account, bond returned
    await escrow.write.settle([cid, U('1.95'), U('0.05'), U('18'), U('0.85'), 0n, U('0.15'), U('2'), 0n], { account: owner.account });
    assert.equal(await bal(escrow.address), e0);
    assert.equal(await bal(seller.account.address), s0 + U('1.95') + U('0.85'));
    assert.equal(await bal(buyer.account.address), b0 + U('18') + U('2'));
    assert.equal(await bal(feeAccount), f0 + U('0.05') + U('0.15'));
  });

  it('anyone can refund an unfilled offer after its deadline, not before', async () => {
    const cid = id('c5');
    const t = await now();
    await escrow.write.open([cid, U('5'), t + 3600n], { account: buyer.account });
    await assert.rejects(escrow.write.refundUnfilled([cid], { account: stranger.account }));
    await networkHelpers.time.increase(3601);
    const b0 = await bal(buyer.account.address);
    await escrow.write.refundUnfilled([cid], { account: stranger.account });
    assert.equal(await bal(buyer.account.address), b0 + U('5'));
  });

  it('missed delivery refunds the buyer and forfeits the stake to the buyer', async () => {
    const cid = id('c6');
    await openAndCommit(cid);
    await assert.rejects(escrow.write.refundMissedDelivery([cid], { account: stranger.account }));
    await networkHelpers.time.increase(7201);
    const b0 = await bal(buyer.account.address);
    await escrow.write.refundMissedDelivery([cid], { account: stranger.account });
    assert.equal(await bal(buyer.account.address), b0 + U('20') + U('1'));
  });

  it('silent buyer: arbiter may settle after delivery deadline plus assessment window', async () => {
    const cid = id('c7');
    await openAndCommit(cid);
    await networkHelpers.time.increase(7200 + 24 * 3600 + 1);
    const s0 = await bal(seller.account.address);
    await escrow.write.settle([cid, U('19.8'), U('0.2'), 0n, U('1'), 0n, 0n, 0n, 0n], { account: owner.account });
    assert.equal(await bal(seller.account.address), s0 + U('19.8') + U('1'));
  });

  it('enforces the per-contract cap and pause on new opens only', async () => {
    await assert.rejects(escrow.write.open([id('c8'), U('50.000001'), (await now()) + 3600n], { account: buyer.account }));
    await escrow.write.setPaused([true], { account: owner.account });
    await assert.rejects(escrow.write.open([id('c9'), U('1'), (await now()) + 3600n], { account: buyer.account }));
    // an existing disputed contract can still be settled while paused
    await escrow.write.setPaused([false], { account: owner.account });
    const cid = id('c10');
    await openAndCommit(cid, '4', '0.2');
    await escrow.write.dispute([cid, U('0.4')], { account: buyer.account });
    await escrow.write.setPaused([true], { account: owner.account });
    await escrow.write.settle([cid, U('4'), 0n, 0n, U('0.2'), 0n, 0n, U('0.4'), 0n], { account: owner.account });
    await escrow.write.setPaused([false], { account: owner.account });
  });

  it('only the owner changes params, arbiter and fee account; fee capped at 10%', async () => {
    await assert.rejects(escrow.write.setParams([U('100'), 100, U('0.05'), 86400n], { account: buyer.account }));
    await assert.rejects(escrow.write.setParams([U('100'), 1001, U('0.05'), 86400n], { account: owner.account }));
    await escrow.write.setParams([U('100'), 150, U('0.05'), 86400n], { account: owner.account });
    assert.equal(await escrow.read.maxPrice(), U('100'));
    assert.equal(await escrow.read.feeFor([U('10')]), U('0.15'));
    await escrow.write.setArbiter([stranger.account.address], { account: owner.account });
    assert.equal((await escrow.read.arbiter()).toLowerCase(), stranger.account.address.toLowerCase());
  });
});
