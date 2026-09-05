// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Minimal ERC-20 surface we need.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title HoldworkEscrow v2
/// @notice Per-contract escrow for agent work, USDC-denominated.
///
///   Happy path (no Holdwork key involved):
///     buyer.open(price)  ->  seller.commit(stake)  ->  buyer.accept(toSeller)
///     accept pays the seller their share plus stake, refunds the remainder to the buyer,
///     and sends the protocol fee to feeAccount. Only the buyer can trigger it.
///
///   Dispute path:
///     buyer.dispute(bond)  ->  arbiter.settle(exact split)
///     The arbiter can act only on disputed contracts, or on committed contracts the buyer has
///     left silent past the assessment window. Every unit held must be accounted for in the split,
///     so the arbiter can redistribute within one contract but can never take more than the fee it
///     declares and can never touch another contract.
///
///   Timeouts (anyone may trigger):
///     refundUnfilled       offer nobody took past its deadline
///     refundMissedDelivery seller committed and missed delivery; buyer gets price plus stake
///
///   Owner (a multisig later, the hot wallet during the pilot) sets caps, arbiter, fee account,
///   and pause. Pause blocks new opens and commits only; settlement and refunds always work,
///   so funds are never trapped.
contract HoldworkEscrow {
    IERC20 public immutable usdc;
    address public owner;
    address public arbiter;
    address public feeAccount;
    uint256 public maxPrice;          // per-contract cap, raised with track record
    uint16 public feeBps;             // protocol fee on the amount released to the seller
    uint256 public minFee;            // floor on that fee, in USDC units (6 decimals)
    uint64 public assessmentWindow;   // seconds after deliveryDeadline before arbiter may settle a silent buyer
    bool public paused;

    enum State { None, Open, Committed, Disputed, Settled, Refunded }

    struct Escrow {
        address buyer;
        address seller;
        uint256 price;
        uint256 stake;
        uint256 bond;
        uint64 offerDeadline;
        uint64 deliveryDeadline;
        State state;
    }

    mapping(bytes32 => Escrow) public escrows;

    event Opened(bytes32 indexed id, address indexed buyer, uint256 price, uint64 offerDeadline);
    event Committed(bytes32 indexed id, address indexed seller, uint256 stake, uint64 deliveryDeadline);
    event Accepted(bytes32 indexed id, uint256 toSeller, uint256 fee, uint256 refund);
    event Disputed(bytes32 indexed id, uint256 bond);
    event Settled(bytes32 indexed id, uint256 toSeller, uint256 fee, uint256 refund, uint256 stakeToSeller, uint256 stakeToBuyer, uint256 stakeToFee, uint256 bondToBuyer, uint256 bondToFee);
    event Refunded(bytes32 indexed id, uint256 toBuyer, uint256 stakeToBuyer);
    event ParamsChanged(uint256 maxPrice, uint16 feeBps, uint256 minFee, uint64 assessmentWindow);
    event ArbiterChanged(address indexed arbiter);
    event FeeAccountChanged(address indexed feeAccount);
    event OwnerChanged(address indexed owner);
    event Paused(bool paused);

    error NotOwner();
    error NotArbiter();
    error NotBuyer();
    error BadState();
    error IsPaused();
    error OverCap();
    error SplitMismatch();
    error TooEarly();
    error TooLate();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyArbiter() { if (msg.sender != arbiter) revert NotArbiter(); _; }

    constructor(IERC20 _usdc, address _owner, address _arbiter, address _feeAccount, uint256 _maxPrice) {
        if (_owner == address(0) || _arbiter == address(0) || _feeAccount == address(0)) revert ZeroAddress();
        usdc = _usdc;
        owner = _owner;
        arbiter = _arbiter;
        feeAccount = _feeAccount;
        maxPrice = _maxPrice;
        feeBps = 100;               // 1%
        minFee = 50_000;            // 0.05 USDC
        assessmentWindow = 24 hours;
    }

    // ───────── buyer ─────────

    /// @notice Lock the task price. `id` is the Holdwork contract id hashed off-chain.
    function open(bytes32 id, uint256 price, uint64 offerDeadline) external {
        if (paused) revert IsPaused();
        if (price == 0 || price > maxPrice) revert OverCap();
        Escrow storage e = escrows[id];
        if (e.state != State.None) revert BadState();
        e.buyer = msg.sender;
        e.price = price;
        e.offerDeadline = offerDeadline;
        e.state = State.Open;
        _pull(msg.sender, price);
        emit Opened(id, msg.sender, price, offerDeadline);
    }

    /// @notice Buyer accepts delivered work and releases `toSeller` of the price. The rest is refunded.
    ///         Holdwork computes `toSeller` off-chain from the buyer's quality claim; on-chain it is
    ///         simply the buyer's own instruction about the buyer's own money.
    function accept(bytes32 id, uint256 toSeller) external {
        Escrow storage e = escrows[id];
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != State.Committed) revert BadState();
        if (toSeller > e.price) revert SplitMismatch();
        uint256 fee = _fee(toSeller);
        uint256 refund = e.price - toSeller;
        e.state = State.Settled;
        _push(e.seller, toSeller - fee + e.stake);
        _push(e.buyer, refund);
        _push(feeAccount, fee);
        emit Accepted(id, toSeller, fee, refund);
    }

    /// @notice Buyer disputes delivered work and posts a bond. The arbiter now decides the split.
    function dispute(bytes32 id, uint256 bond) external {
        Escrow storage e = escrows[id];
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != State.Committed) revert BadState();
        e.bond = bond;
        e.state = State.Disputed;
        _pull(msg.sender, bond);
        emit Disputed(id, bond);
    }

    // ───────── seller ─────────

    /// @notice Seller commits to an open offer and locks a stake.
    function commit(bytes32 id, uint256 stake, uint64 deliveryDeadline) external {
        if (paused) revert IsPaused();
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert BadState();
        if (block.timestamp > e.offerDeadline) revert TooLate();
        if (msg.sender == e.buyer) revert BadState();
        e.seller = msg.sender;
        e.stake = stake;
        e.deliveryDeadline = deliveryDeadline;
        e.state = State.Committed;
        _pull(msg.sender, stake);
        emit Committed(id, msg.sender, stake, deliveryDeadline);
    }

    // ───────── anyone: timeouts ─────────

    function refundUnfilled(bytes32 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert BadState();
        if (block.timestamp <= e.offerDeadline) revert TooEarly();
        e.state = State.Refunded;
        _push(e.buyer, e.price);
        emit Refunded(id, e.price, 0);
    }

    function refundMissedDelivery(bytes32 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Committed) revert BadState();
        if (block.timestamp <= e.deliveryDeadline) revert TooEarly();
        e.state = State.Refunded;
        _push(e.buyer, e.price + e.stake);
        emit Refunded(id, e.price, e.stake);
    }

    // ───────── arbiter ─────────

    /// @notice Settle a disputed contract, or a committed one whose buyer went silent past the
    ///         assessment window, with an explicit split. Every held unit must be accounted for.
    ///         Legs to feeAccount cover the protocol fee and verifier fees (paid from the losing
    ///         side's stake or bond), which Holdwork then distributes to verifiers off-chain.
    function settle(
        bytes32 id,
        uint256 toSeller,
        uint256 fee,
        uint256 refund,
        uint256 stakeToSeller,
        uint256 stakeToBuyer,
        uint256 stakeToFee,
        uint256 bondToBuyer,
        uint256 bondToFee
    ) external onlyArbiter {
        Escrow storage e = escrows[id];
        if (e.state == State.Committed) {
            if (block.timestamp <= uint256(e.deliveryDeadline) + assessmentWindow) revert TooEarly();
        } else if (e.state != State.Disputed) {
            revert BadState();
        }
        if (toSeller + fee + refund != e.price) revert SplitMismatch();
        if (stakeToSeller + stakeToBuyer + stakeToFee != e.stake) revert SplitMismatch();
        if (bondToBuyer + bondToFee != e.bond) revert SplitMismatch();
        e.state = State.Settled;
        _push(e.seller, toSeller + stakeToSeller);
        _push(e.buyer, refund + stakeToBuyer + bondToBuyer);
        _push(feeAccount, fee + stakeToFee + bondToFee);
        emit Settled(id, toSeller, fee, refund, stakeToSeller, stakeToBuyer, stakeToFee, bondToBuyer, bondToFee);
    }

    // ───────── owner ─────────

    function setParams(uint256 _maxPrice, uint16 _feeBps, uint256 _minFee, uint64 _assessmentWindow) external onlyOwner {
        if (_feeBps > 1000) revert SplitMismatch(); // never more than 10%
        maxPrice = _maxPrice;
        feeBps = _feeBps;
        minFee = _minFee;
        assessmentWindow = _assessmentWindow;
        emit ParamsChanged(_maxPrice, _feeBps, _minFee, _assessmentWindow);
    }

    function setArbiter(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); arbiter = a; emit ArbiterChanged(a); }
    function setFeeAccount(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); feeAccount = a; emit FeeAccountChanged(a); }
    function setOwner(address a) external onlyOwner { if (a == address(0)) revert ZeroAddress(); owner = a; emit OwnerChanged(a); }
    function setPaused(bool p) external onlyOwner { paused = p; emit Paused(p); }

    // ───────── views ─────────

    function feeFor(uint256 toSeller) external view returns (uint256) { return _fee(toSeller); }

    // ───────── internals ─────────

    function _fee(uint256 toSeller) internal view returns (uint256) {
        if (toSeller == 0) return 0;
        uint256 f = (toSeller * feeBps) / 10_000;
        if (f < minFee) f = minFee;
        if (f > toSeller) f = toSeller;
        return f;
    }

    function _pull(address from, uint256 amount) internal {
        if (amount == 0) return;
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
