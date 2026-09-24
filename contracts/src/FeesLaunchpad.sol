// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeSplitter, IPonsFeeEscrow, IFeesClaims} from "./FeeSplitter.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * Pons V2's launch factory, `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`. Same interface Pons
 * Charity launches through; see `CharityLaunchpadV2`.
 *
 * ⭐⭐ `creatorFeeRecipient` IS A LAUNCH PARAMETER, so the splitter is named at launch and there is
 * no moment in which a launch exists with its fees pointed anywhere else.
 */
interface IPonsV2Factory {
    struct Socials {
        string twitter;
        string telegram;
        string discord;
        string website;
        string farcaster;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address creatorFeeRecipient;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        bytes32 expectedEconomics;
        bytes32 salt;
    }

    function launchToken(LaunchParams calldata params, uint256 launchConfigId, address pairToken)
        external
        payable
        returns (address token, address curve);

    function launchToken(
        LaunchParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve);

    /// ⚠ Rotatable. Read live, never pinned.
    function launchForwarder() external view returns (address);
    function launchEnabled() external view returns (bool);
    function launchFee() external view returns (uint256);
    function approvedPairTokens(address pairToken) external view returns (bool);
    function previewLaunchEconomics(uint256 launchConfigId, address pairToken) external view returns (bytes32);
    function feeEscrow() external view returns (address);
}

/**
 * Pons's periphery: launch and developer buy in ONE transaction, the only way to buy at launch
 * without being sniped. ⚠⚠ Its native value check is EXACT: `launchFee + quoteIn` on a native pair,
 * `launchFee` alone otherwise.
 */
interface IPonsV2LaunchAndBuy {
    function launchAndBuy(
        IPonsV2Factory.LaunchParams calldata params,
        uint256 launchConfigId,
        address pairToken,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve, uint256 tokensOut);
}

/**
 * FEES — launch a Pons V2 token whose creator fees are shared with X, GitHub and Twitch accounts.
 *
 * ## What one call does
 *
 * 1. Deploys a {FeeSplitter} with the shares written in, immutably.
 * 2. Launches the token on Pons V2 with that splitter as `creatorFeeRecipient`.
 * 3. Binds the splitter to the token and records the launch in an on-chain registry.
 *
 * ⭐⭐ ATOMIC. Done as separate transactions there would be a window where a live token earns fees
 * into the wrong place. Here a partial launch does not exist: it reverts.
 *
 * ## ⭐ WHY THE REGISTRY IS AN ARRAY AND NOT AN EVENT
 *
 * Robinhood Chain makes a block roughly every 100ms and the public RPC caps `eth_getLogs` at 2,000
 * blocks, about three minutes. An array read with `eth_call` needs no indexer and cannot fall behind.
 *
 * ⛔ No owner and no fee of its own. This contract cannot take anything from a launch.
 */
contract FeesLaunchpad {
    using SafeERC20 for IERC20;

    IPonsV2Factory public immutable factory;
    IPonsFeeEscrow public immutable escrow;
    IFeesClaims public immutable claims;

    struct Entry {
        address token;
        address curve;
        address splitter;
        address creator;
        address pairToken;
        uint64 launchedAt;
    }

    struct DevBuy {
        uint256 quoteIn;
        uint256 minTokensOut;
    }

    Entry[] private _launches;
    mapping(address => uint256) private _indexOfPlusOne;

    event FeesLaunch(address indexed token, address indexed splitter, address indexed creator, address pairToken);

    error LaunchesClosed();
    error ZeroAddress();
    error PairTokenNotApproved(address pairToken);
    error EconomicsMoved(bytes32 pinned, bytes32 live);
    error DevBuyUnavailable();
    error NotOurLaunch(address token);

    constructor(IPonsV2Factory factory_, IFeesClaims claims_) {
        if (address(factory_) == address(0) || address(claims_) == address(0)) revert ZeroAddress();
        factory = factory_;
        escrow = IPonsFeeEscrow(factory_.feeEscrow());
        claims = claims_;
    }

    /**
     * Launch a token whose creator fees are split between `shares`, for the life of the token.
     *
     * @param params Pons's own launch struct. ⚠ `creatorFeeRecipient` is IGNORED and overwritten
     *        with the splitter this call creates.
     * @param shares Who is paid, adding to 10,000 bps. See {FeeSplitter}.
     * @param devBuy `quoteIn` in the pair asset's units, zero to opt out. ⚠ A zero `minTokensOut`
     *        is a free sandwich; the interface computes one.
     */
    function launch(
        IPonsV2Factory.LaunchParams memory params,
        uint256 launchConfigId,
        address pairToken,
        FeeSplitter.Share[] calldata shares,
        DevBuy calldata devBuy,
        address[] calldata snipeTaxExemptions
    ) external payable returns (address token, address curve, address splitter) {
        if (!factory.launchEnabled()) revert LaunchesClosed();
        if (pairToken != address(0) && !factory.approvedPairTokens(pairToken)) {
            revert PairTokenNotApproved(pairToken);
        }
        /* ⛔ Re-checked here so a moved pin surfaces as "the terms moved, read them again" rather
           than an opaque factory revert. A zero pin means the caller opted out, which Pons allows. */
        if (params.expectedEconomics != bytes32(0)) {
            bytes32 live = factory.previewLaunchEconomics(launchConfigId, pairToken);
            if (live != params.expectedEconomics) revert EconomicsMoved(params.expectedEconomics, live);
        }

        splitter = address(new FeeSplitter(escrow, claims, shares));
        params.creatorFeeRecipient = splitter;

        (token, curve) = _launchOnPons(params, launchConfigId, pairToken, devBuy, snipeTaxExemptions);

        /* ⛔⛔ Bound in the same transaction as the launch: no window with an unbound splitter. */
        FeeSplitter(payable(splitter)).initialize(token, curve, pairToken);

        _indexOfPlusOne[token] = _launches.length + 1;
        _launches.push(
            Entry({
                token: token,
                curve: curve,
                splitter: splitter,
                creator: msg.sender,
                pairToken: pairToken,
                launchedAt: uint64(block.timestamp)
            })
        );
        emit FeesLaunch(token, splitter, msg.sender, pairToken);
    }

    /**
     * ⛔⛔ THREE ENTRYPOINTS, AND AN EMPTY ARRAY IS NOT THE SAME CALLDATA AS NO ARRAY. The plain
     * three-argument `launchToken` is sent when there is nothing to declare and nothing to buy.
     */
    function _launchOnPons(
        IPonsV2Factory.LaunchParams memory params,
        uint256 launchConfigId,
        address pairToken,
        DevBuy calldata devBuy,
        address[] calldata exemptions
    ) private returns (address token, address curve) {
        if (devBuy.quoteIn == 0) {
            if (exemptions.length == 0) {
                return factory.launchToken{value: msg.value}(params, launchConfigId, pairToken);
            }
            return factory.launchToken{value: msg.value}(params, launchConfigId, pairToken, exemptions);
        }

        address forwarder = factory.launchForwarder();
        if (forwarder == address(0)) revert DevBuyUnavailable();

        bool nativeQuote = pairToken == address(0);
        if (!nativeQuote) {
            /* ⛔⛔ The periphery pulls the quote from ITS caller, which is this contract, so the
               launcher approves THIS contract and the tokens are brought here first. */
            IERC20(pairToken).safeTransferFrom(msg.sender, address(this), devBuy.quoteIn);
            IERC20(pairToken).forceApprove(forwarder, devBuy.quoteIn);
        }

        /* ⛔⛔ `recipient` is the LAUNCHER, never the splitter. Pons V1 sent a dev buy to the fee
           recipient and it cost a launch 2.84% of its supply once. */
        (token, curve,) = IPonsV2LaunchAndBuy(forwarder).launchAndBuy{value: msg.value}(
            params, launchConfigId, pairToken, devBuy.quoteIn, devBuy.minTokensOut, msg.sender, exemptions
        );

        if (!nativeQuote) IERC20(pairToken).forceApprove(forwarder, 0);
    }

    /* ---------------------------------------------------------------- registry -- */

    function count() external view returns (uint256) {
        return _launches.length;
    }

    /// A page of the registry, newest first. ⚠ Clamped rather than reverting past the end.
    function page(uint256 offset, uint256 limit) external view returns (Entry[] memory out) {
        uint256 n = _launches.length;
        if (offset >= n || limit == 0) return new Entry[](0);
        uint256 take = n - offset;
        if (take > limit) take = limit;
        out = new Entry[](take);
        for (uint256 i = 0; i < take; i++) {
            out[i] = _launches[n - 1 - offset - i];
        }
    }

    /// ⚠ Reverts for a token this launchpad did not create, rather than returning an empty entry.
    function entryOf(address token) external view returns (Entry memory) {
        uint256 idx = _indexOfPlusOne[token];
        if (idx == 0) revert NotOurLaunch(token);
        return _launches[idx - 1];
    }

    function isLaunch(address token) external view returns (bool) {
        return _indexOfPlusOne[token] != 0;
    }

    function splitterOf(address token) external view returns (address) {
        uint256 idx = _indexOfPlusOne[token];
        return idx == 0 ? address(0) : _launches[idx - 1].splitter;
    }
}
