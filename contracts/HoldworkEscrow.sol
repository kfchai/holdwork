// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Minimal ERC-20 surface we need.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title HoldworkEscrow
/// @notice Non-custodial escrow for agent work. Buyer locks USDC, seller locks a stake,
///         the arbiter (Holdwork) settles with an explicit split that must sum exactly to
///         what is held. Holdwork can never move more than is locked for that contract and
///         can never move funds between contracts.
/// @dev    Deliberately small. No upgradeability. Pause only blocks new locks; settlement
///         and refund paths stay open so funds are never trapped.
contract HoldworkEscrow {
    IERC20 public immutable usdc;
    address public arbiter;
    address public feeAccount;
    bool public paused;

    enum State { None, Open, Committed, Settled, Refunded }

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
    event Bonded(bytes32 indexed id, uint256 bond);
    event Settled(bytes32 indexed id, uint256 toSeller, uint256 fee, uint256 refund, uint256 stakeToSeller, uint256 stakeToBuyer, uint256 bondToBuyer, uint256 bondToFee);
    event Refunded(bytes32 indexed id, uint256 toBuyer, uint256 stakeToBuyer);
    event ArbiterChanged(address indexed arbiter);
    event Paused(bool paused);

    error NotArbiter();
    error BadState();
    error IsPaused();
    error SplitMismatch();
    error TooEarly();
    error TransferFailed();

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    constructor(IERC20 _usdc, address _arbiter, address _feeAccount) {
        usdc = _usdc;
        arbiter = _arbiter;
        feeAccount = _feeAccount;
    }

    // ───────── buyer ─────────

    /// @notice Buyer locks the task price. `id` is the Holdwork contract id hashed off-chain.
    function open(bytes32 id, uint256 price, uint64 offerDeadline) external {
        if (paused) revert IsPaused();
        Escrow storage e = escrows[id];
        if (e.state != State.None) revert BadState();
        e.buyer = msg.sender;
        e.price = price;
        e.offerDeadline = offerDeadline;
        e.state = State.Open;
        _pull(msg.sender, price);
        emit Opened(id, msg.sender, price, offerDeadline);
    }

    /// @notice Buyer posts a dispute bond after delivery. Arbiter decides where it goes at settle.
    function bond(bytes32 id, uint256 amount) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Committed || msg.sender != e.buyer) revert BadState();
        e.bond += amount;
        _pull(msg.sender, amount);
        emit Bonded(id, amount);
    }

    /// @notice Anyone may refund an offer nobody took once its deadline passes.
    function refundUnfilled(bytes32 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert BadState();
        if (block.timestamp <= e.offerDeadline) revert TooEarly();
        e.state = State.Refunded;
        _push(e.buyer, e.price);
        emit Refunded(id, e.price, 0);
    }

    /// @notice Anyone may refund the buyer, and hand them the stake, once a committed seller misses delivery.
    function refundMissedDelivery(bytes32 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.Committed) revert BadState();
        if (block.timestamp <= e.deliveryDeadline) revert TooEarly();
        e.state = State.Refunded;
        uint256 total = e.price + e.stake + e.bond;
        _push(e.buyer, total);
        emit Refunded(id, e.price + e.bond, e.stake);
    }

    // ───────── seller ─────────

    /// @notice Seller commits and locks a stake.
    function commit(bytes32 id, uint256 stake, uint64 deliveryDeadline) external {
        if (paused) revert IsPaused();
        Escrow storage e = escrows[id];
        if (e.state != State.Open) revert BadState();
        if (block.timestamp > e.offerDeadline) revert TooEarly();
        e.seller = msg.sender;
        e.stake = stake;
        e.deliveryDeadline = deliveryDeadline;
        e.state = State.Committed;
        _pull(msg.sender, stake);
        emit Committed(id, msg.sender, stake, deliveryDeadline);
    }

    // ───────── arbiter ─────────

    /// @notice Settle with an explicit split. Every held unit must be accounted for, so the arbiter
    ///         can redistribute within a contract but can never take more than the fee it declares
    ///         or touch other contracts.
    function settle(
        bytes32 id,
        uint256 toSeller,
        uint256 fee,
        uint256 refund,
        uint256 stakeToSeller,
        uint256 stakeToBuyer,
        uint256 bondToBuyer,
        uint256 bondToFee
    ) external onlyArbiter {
        Escrow storage e = escrows[id];
        if (e.state != State.Committed) revert BadState();
        if (toSeller + fee + refund != e.price) revert SplitMismatch();
        if (stakeToSeller + stakeToBuyer != e.stake) revert SplitMismatch();
        if (bondToBuyer + bondToFee != e.bond) revert SplitMismatch();
        e.state = State.Settled;
        _push(e.seller, toSeller + stakeToSeller);
        _push(e.buyer, refund + stakeToBuyer + bondToBuyer);
        _push(feeAccount, fee + bondToFee);
        emit Settled(id, toSeller, fee, refund, stakeToSeller, stakeToBuyer, bondToBuyer, bondToFee);
    }

    function setArbiter(address a) external onlyArbiter {
        arbiter = a;
        emit ArbiterChanged(a);
    }

    function setPaused(bool p) external onlyArbiter {
        paused = p;
        emit Paused(p);
    }

    // ───────── internals ─────────

    function _pull(address from, uint256 amount) internal {
        if (amount == 0) return;
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
