/** ABI of HoldworkEscrow v2, kept in sync with contracts/HoldworkEscrow.sol (see test/contract). */
export const HOLDWORK_ESCROW_ABI = [
  { type: 'function', name: 'open', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'price', type: 'uint256' }, { name: 'offerDeadline', type: 'uint64' }], outputs: [] },
  { type: 'function', name: 'commit', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'stake', type: 'uint256' }, { name: 'deliveryDeadline', type: 'uint64' }], outputs: [] },
  { type: 'function', name: 'accept', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'toSeller', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'dispute', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'bond', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'refundUnfilled', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'refundMissedDelivery', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [] },
  {
    type: 'function', name: 'settle', stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' }, { name: 'toSeller', type: 'uint256' }, { name: 'fee', type: 'uint256' }, { name: 'refund', type: 'uint256' },
      { name: 'stakeToSeller', type: 'uint256' }, { name: 'stakeToBuyer', type: 'uint256' }, { name: 'stakeToFee', type: 'uint256' },
      { name: 'bondToBuyer', type: 'uint256' }, { name: 'bondToFee', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'escrows', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'price', type: 'uint256' }, { name: 'stake', type: 'uint256' },
      { name: 'bond', type: 'uint256' }, { name: 'offerDeadline', type: 'uint64' }, { name: 'deliveryDeadline', type: 'uint64' }, { name: 'state', type: 'uint8' },
    ],
  },
  { type: 'function', name: 'maxPrice', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'feeFor', stateMutability: 'view', inputs: [{ name: 'toSeller', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'event', name: 'Opened', inputs: [{ name: 'id', type: 'bytes32', indexed: true }, { name: 'buyer', type: 'address', indexed: true }, { name: 'price', type: 'uint256', indexed: false }, { name: 'offerDeadline', type: 'uint64', indexed: false }] },
  { type: 'event', name: 'Committed', inputs: [{ name: 'id', type: 'bytes32', indexed: true }, { name: 'seller', type: 'address', indexed: true }, { name: 'stake', type: 'uint256', indexed: false }, { name: 'deliveryDeadline', type: 'uint64', indexed: false }] },
  { type: 'event', name: 'Accepted', inputs: [{ name: 'id', type: 'bytes32', indexed: true }, { name: 'toSeller', type: 'uint256', indexed: false }, { name: 'fee', type: 'uint256', indexed: false }, { name: 'refund', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Disputed', inputs: [{ name: 'id', type: 'bytes32', indexed: true }, { name: 'bond', type: 'uint256', indexed: false }] },
  {
    type: 'event', name: 'Settled',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true }, { name: 'toSeller', type: 'uint256', indexed: false }, { name: 'fee', type: 'uint256', indexed: false }, { name: 'refund', type: 'uint256', indexed: false },
      { name: 'stakeToSeller', type: 'uint256', indexed: false }, { name: 'stakeToBuyer', type: 'uint256', indexed: false }, { name: 'stakeToFee', type: 'uint256', indexed: false },
      { name: 'bondToBuyer', type: 'uint256', indexed: false }, { name: 'bondToFee', type: 'uint256', indexed: false },
    ],
  },
  { type: 'event', name: 'Refunded', inputs: [{ name: 'id', type: 'bytes32', indexed: true }, { name: 'toBuyer', type: 'uint256', indexed: false }, { name: 'stakeToBuyer', type: 'uint256', indexed: false }] },
] as const;

export const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

/** Mirrors `enum State` in the contract. */
export const ESCROW_STATE = ['None', 'Open', 'Committed', 'Disputed', 'Settled', 'Refunded'] as const;
