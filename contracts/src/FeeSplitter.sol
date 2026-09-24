// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Strings} from "openzeppelin-contracts/contracts/utils/Strings.sol";

/**
 * Pons V2's fee escrow. Signatures recovered and proven on Pons Charity, see `CharityDistributor`.
 *
 * ⚠⚠ TWO LEDGERS. `balanceOf(recipient)` is native ETH; `balanceOfToken(recipient, token)` is
 * everything else. A launch paired against USDG credits ONLY the token ledger and its native side
 * reads zero forever, so both are harvested and neither is inferred from the other.
 *
 * ⚠ Both claims pay `msg.sender` and REVERT when there is nothing to claim, so every call is wrapped.
 */
interface IPonsFeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}

/**
 * ⛔ Takes the uint argument. A no-arg `sweepFees()` compiles, is a different selector, and reverts
 * with no data, which is indistinguishable from a permission failure.
 */
interface IPonsCurveSweep {
    function sweepFees(uint256 minBuybackTokensOut) external;
}

interface IPonsHookSweep {
    function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut) external;
}

interface IFeesClaims {
    function fund(address launch, bytes32 beneficiary, address asset, uint256 amount) external payable;
}

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * One launch's fee recipient: every fee it earns, split between wallets and accounts, for ever.
 *
 * ## What it holds
 *
 * A list of shares written at construction and never changed. A share is either
 *
 * - a **wallet**, pushed its cut on every distribution, or
 * - an **account** on X, GitHub or Twitch, whose cut is ring-fenced in {FeesClaims} against the
 *   account's permanent numeric id until the owner signs in and claims it.
 *
 * ## ⭐⭐ PERMISSIONLESS FROM TRADE TO PAYOUT
 *
 * Pons only lets a launch's own fee recipient sweep its curve or claim its escrow, and this contract
 * is that recipient. Every step is open to anyone: the keeper runs them on a timer, but a stranger,
 * a payee or a block explorer can run the same calls, so nothing stops the day one key goes quiet.
 *
 * ## ⛔⛔ NO OWNER, NO WITHDRAW, NO SETTER
 *
 * Nothing here can change where money goes. The only functions that move value out pay the shares
 * written at construction, in the proportions written at construction.
 */
contract FeeSplitter {
    /// 0 is a wallet. The rest name the provider an account id belongs to.
    uint8 internal constant WALLET = 0;
    uint8 internal constant PROVIDER_X = 1;
    uint8 internal constant PROVIDER_GITHUB = 2;
    uint8 internal constant PROVIDER_TWITCH = 3;

    /// ⚠ A bound on the loop every distribution runs, so gas cannot grow without limit.
    uint256 public constant MAX_SHARES = 10;

    struct Share {
        uint8 provider;
        uint16 bps;
        address wallet;
        uint256 accountId;
        bytes32 beneficiary;
    }

    IPonsFeeEscrow public immutable escrow;
    IFeesClaims public immutable claims;
    /// The launchpad that built this, and the only caller {initialize} accepts.
    address public immutable launchpad;

    address public token;
    address public curve;
    address public pairToken;

    Share[] private _shares;

    /// Lifetime totals per asset (native is address(0)). The ledger the site renders.
    mapping(address => uint256) public totalToWallets;
    mapping(address => uint256) public totalToAccounts;

    /**
     * A wallet share whose push was refused, held for that wallet to pull.
     *
     * ⛔⛔ WITHOUT THIS ONE WALLET CAN STOP EVERYBODY BEING PAID. A contract wallet that reverts on
     * receiving ETH would revert every distribution, and every co-recipient's share would sit here
     * for ever. A failed push is parked and the loop carries on.
     */
    mapping(address => mapping(address => uint256)) public parked;
    mapping(address => uint256) public parkedTotal;

    event Initialized(address indexed token, address indexed curve, address pairToken);
    event Distributed(address indexed asset, uint256 toWallets, uint256 toAccounts);
    event Parked(address indexed wallet, address indexed asset, uint256 amount);

    error BadShares();
    error BeneficiaryMismatch(bytes32 declared, bytes32 computed);
    error NotLaunchpad();
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAddress();
    error TransferFailed();
    error Reentered();

    /**
     * ⛔⛔ A WALLET SHARE IS CALLED MID-LOOP. While it runs, this contract still holds every cut the
     * loop has not paid yet, so a wallet that re-entered `distribute` would split that money a
     * second time and the outer loop would then pay from a balance that no longer covers it.
     */
    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IPonsFeeEscrow escrow_, IFeesClaims claims_, Share[] memory shares_) {
        if (address(escrow_) == address(0)) revert ZeroAddress();
        uint256 n = shares_.length;
        if (n == 0 || n > MAX_SHARES) revert BadShares();

        uint256 total;
        bool needsClaims;
        for (uint256 i = 0; i < n; i++) {
            Share memory s = shares_[i];
            if (s.bps == 0) revert BadShares();
            if (s.provider == WALLET) {
                if (s.wallet == address(0) || s.accountId != 0 || s.beneficiary != bytes32(0)) revert BadShares();
            } else {
                if (s.provider > PROVIDER_TWITCH || s.wallet != address(0) || s.accountId == 0) revert BadShares();
                /*
                  ⛔⛔ THE DECLARED ACCOUNT MUST BE THE ONE PAID, AND THAT IS PROVEN HERE.
                  Left unchecked, `provider` and `accountId` are two numbers a launcher could set to
                  anything, so a token page could name an account that is paid nothing while the
                  money went to a hash nobody can read. Recomputing the hash from the declared pair
                  makes that lie unrepresentable rather than merely detectable.
                  ⚠ The string MUST match `key()` in api/identity.mjs byte for byte.
                */
                bytes32 computed = keccak256(abi.encodePacked(_prefix(s.provider), Strings.toString(s.accountId)));
                if (computed != s.beneficiary) revert BeneficiaryMismatch(s.beneficiary, computed);
                needsClaims = true;
            }
            total += s.bps;
            _shares.push(s);
        }
        /* ⛔ Exactly 10,000. Under, and the remainder accumulates here with nothing able to move it. */
        if (total != 10_000) revert BadShares();
        if (needsClaims && address(claims_) == address(0)) revert ZeroAddress();

        escrow = escrow_;
        claims = claims_;
        launchpad = msg.sender;
    }

    function _prefix(uint8 provider) private pure returns (string memory) {
        if (provider == PROVIDER_X) return "x:";
        if (provider == PROVIDER_GITHUB) return "github:";
        return "twitch:";
    }

    /**
     * Binds this splitter to the launch it is the fee recipient of.
     *
     * ⚠ The token cannot be a constructor argument: Pons hashes the whole launch, fee recipient
     * included, into the token's address, so the token does not exist until after this does. The
     * launchpad calls this in the same transaction as the launch, so there is no window where an
     * unbound splitter exists.
     */
    function initialize(address token_, address curve_, address pairToken_) external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        if (token != address(0)) revert AlreadyInitialized();
        if (token_ == address(0) || curve_ == address(0)) revert ZeroAddress();
        token = token_;
        curve = curve_;
        pairToken = pairToken_;
        emit Initialized(token_, curve_, pairToken_);
    }

    /// ⚠ Required. The escrow pays native fees by SENDING ether.
    receive() external payable {}

    function shares() external view returns (Share[] memory) {
        return _shares;
    }

    function shareCount() external view returns (uint256) {
        return _shares.length;
    }

    /* ------------------------------------------------------------------- sweep -- */

    /**
     * Moves this launch's fees off its bonding curve into the escrow.
     * ⭐ Pons accepts this only from the fee recipient, which is why it is forwarded from here.
     */
    function sweepCurve(uint256 minBuybackTokensOut) external {
        if (curve == address(0)) revert NotInitialized();
        IPonsCurveSweep(curve).sweepFees(minBuybackTokensOut);
    }

    /**
     * The same after graduation, when the fees sit in Pons's V4 hook.
     * ⚠ The hook is caller-named. That is safe: the only effect of `sweepPoolFees` is money moving
     * TO this contract, and this contract holds no approvals a foreign callee could spend.
     */
    function sweepPool(address hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)
        external
    {
        IPonsHookSweep(hook).sweepPoolFees(poolId, minConversionQuoteOut, minBuybackTokensOut);
    }

    /* ----------------------------------------------------------------- harvest -- */

    /// Claims native fees from the escrow and distributes everything held.
    function harvest() public nonReentrant {
        try escrow.claim() {} catch {}
        _distribute(address(0));
    }

    /// The same for an ERC-20: the pair asset, or the launch token itself (snipe tax arrives in it).
    function harvestToken(address asset) public nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        try escrow.claimToken(asset) {} catch {}
        _distribute(asset);
    }

    /// One call for the keeper.
    function harvestAll() external nonReentrant {
        try escrow.claim() {} catch {}
        _distribute(address(0));
        if (pairToken != address(0)) {
            try escrow.claimToken(pairToken) {} catch {}
            _distribute(pairToken);
        }
        _distribute(token);
    }

    /// Distributes what is already held, without touching the escrow.
    function distribute(address asset) external nonReentrant {
        _distribute(asset);
    }

    /* ---------------------------------------------------------------- payout -- */

    /**
     * Splits the balance and pays every share.
     *
     * ⭐ Works off the BALANCE, not off what a claim returned: the claims are wrapped in `try`, and
     * a direct transfer in (snipe tax, a tip) should split on the same terms as a fee.
     * ⭐ The last share takes the remainder, so division never strands dust here.
     * ⛔ Parked money is excluded, or it would be split a second time.
     */
    function _distribute(address asset) internal {
        if (token == address(0)) revert NotInitialized();
        uint256 held = _balance(asset);
        uint256 reserved = parkedTotal[asset];
        uint256 amount = held > reserved ? held - reserved : 0;
        if (amount == 0) return;

        uint256 toWallets;
        uint256 toAccounts;
        uint256 paid;
        uint256 n = _shares.length;
        for (uint256 i = 0; i < n; i++) {
            Share memory s = _shares[i];
            uint256 cut = i == n - 1 ? amount - paid : (amount * s.bps) / 10_000;
            paid += cut;
            if (cut == 0) continue;
            if (s.provider == WALLET) {
                toWallets += cut;
                if (!_trySend(asset, s.wallet, cut)) {
                    parked[s.wallet][asset] += cut;
                    parkedTotal[asset] += cut;
                    emit Parked(s.wallet, asset, cut);
                }
            } else {
                toAccounts += cut;
                _fundClaims(asset, s.beneficiary, cut);
            }
        }
        totalToWallets[asset] += toWallets;
        totalToAccounts[asset] += toAccounts;
        emit Distributed(asset, toWallets, toAccounts);
    }

    /// A wallet whose push was refused collects it here, to itself only.
    function withdrawParked(address asset) external nonReentrant {
        uint256 amount = parked[msg.sender][asset];
        if (amount == 0) return;
        parked[msg.sender][asset] = 0;
        parkedTotal[asset] -= amount;
        if (!_trySend(asset, msg.sender, amount)) revert TransferFailed();
    }

    function _fundClaims(address asset, bytes32 beneficiary, uint256 amount) private {
        if (asset == address(0)) {
            claims.fund{value: amount}(token, beneficiary, address(0), amount);
        } else {
            /* ⚠ Approve exactly, then drive back to zero: no standing allowance is left behind. */
            _call(asset, abi.encodeCall(IERC20Min.approve, (address(claims), amount)));
            claims.fund(token, beneficiary, asset, amount);
            _call(asset, abi.encodeCall(IERC20Min.approve, (address(claims), 0)));
        }
    }

    function _balance(address asset) private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20Min(asset).balanceOf(address(this));
    }

    function _trySend(address asset, address to, uint256 amount) private returns (bool) {
        if (asset == address(0)) {
            /* ⚠ Gas-capped so a hostile wallet cannot burn the whole distribution's gas. */
            (bool ok,) = payable(to).call{value: amount, gas: 50_000}("");
            return ok;
        }
        (bool sent, bytes memory ret) = asset.call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        return sent && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    function _call(address asset, bytes memory data) private {
        (bool ok, bytes memory ret) = asset.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// What the escrow holds for this launch right now, in the native and pair ledgers.
    function pending() external view returns (uint256 native, uint256 pair) {
        native = escrow.balanceOf(address(this));
        if (pairToken != address(0)) pair = escrow.balanceOfToken(address(this), pairToken);
    }
}
