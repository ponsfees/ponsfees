// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {FeesLaunchpad, IPonsV2Factory} from "../src/FeesLaunchpad.sol";
import {FeeSplitter, IFeesClaims} from "../src/FeeSplitter.sol";
import {FeesClaims} from "../src/FeesClaims.sol";

interface ICurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

interface IERC20B {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/**
 * The whole path on a fork of Robinhood Chain, through the REAL Pons factory, periphery, curve and
 * escrow: launch with shares, a developer buy, real trades, sweep, harvest, and a signed claim.
 *
 *   node scripts/rpc-proxy.mjs &        # Cloudflare 403s Foundry's UA
 *   forge test --match-contract FeesForkTest -vv
 */
contract FeesForkTest is Test {
    address constant FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    /* ⚠ Addresses that exist nowhere, so no live balance can move under an assertion. */
    address constant LAUNCHER = 0x00000000000000000000000000000000CaFe0003;
    address constant WALLET = 0x00000000000000000000000000000000caFe0004;
    address constant TRADER = 0x00000000000000000000000000000000CAfe0006;
    address constant PAYEE = 0x00000000000000000000000000000000Cafe0007;

    uint256 signerKey = 0xA11CE5;
    FeesClaims claims;
    FeesLaunchpad pad;
    IPonsV2Factory f = IPonsV2Factory(FACTORY);

    function setUp() public {
        try vm.createSelectFork(vm.envOr("RHC_RPC", string("http://127.0.0.1:8899"))) {}
        catch { vm.skip(true); return; }
        claims = new FeesClaims(address(this), vm.addr(signerKey));
        pad = new FeesLaunchpad(f, IFeesClaims(address(claims)));
    }

    function _shares() internal pure returns (FeeSplitter.Share[] memory s) {
        s = new FeeSplitter.Share[](3);
        s[0] = FeeSplitter.Share(0, 2000, WALLET, 0, bytes32(0));
        s[1] = FeeSplitter.Share(1, 5000, address(0), 44196397, keccak256("x:44196397"));
        s[2] = FeeSplitter.Share(3, 3000, address(0), 12826, keccak256("twitch:12826"));
    }

    function _launch(uint256 devBuy) internal returns (address token, address curve, address splitter) {
        IPonsV2Factory.LaunchParams memory p;
        p.name = "Fees Rehearsal";
        p.symbol = "FEES";
        p.description = "Fees to @elonmusk on X and twitch.tv/twitch";
        p.expectedEconomics = f.previewLaunchEconomics(0, address(0));
        p.salt = keccak256("fees-fork-1");
        uint256 fee = f.launchFee();
        vm.deal(LAUNCHER, fee + devBuy + 1 ether);
        vm.prank(LAUNCHER);
        (token, curve, splitter) = pad.launch{value: fee + devBuy}(
            p, 0, address(0), _shares(), FeesLaunchpad.DevBuy(devBuy, 0), new address[](0)
        );
    }

    function test_realTradesPayTheWalletAndBothAccounts() public {
        (address token, address curve, address splitter) = _launch(0.01 ether);

        assertTrue(pad.isLaunch(token));
        assertEq(pad.splitterOf(token), splitter);
        assertEq(FeeSplitter(payable(splitter)).token(), token, "bound to its own launch");
        assertGt(IERC20B(token).balanceOf(LAUNCHER), 0, "the dev buy went to the LAUNCHER");
        assertEq(IERC20B(token).balanceOf(splitter), 0, "and none of it to the splitter");

        /* ⚠ Past the snipe window. Pons V2 taxes buys 99% decaying over 3 WALL-CLOCK seconds, so a
           trade in the launch second measures the snipe tax, not the fee. */
        vm.warp(block.timestamp + 10);
        vm.deal(TRADER, 20 ether);
        vm.startPrank(TRADER);
        ICurve(curve).buy{value: 0.5 ether}(0.5 ether, 0, TRADER);
        uint256 bought = IERC20B(token).balanceOf(TRADER);
        IERC20B(token).approve(curve, bought);
        ICurve(curve).sell(bought / 2, 0, TRADER);
        vm.stopPrank();

        // ⭐ a stranger runs every step: no key of ours is involved from trade to credit
        vm.startPrank(address(0xdead));
        FeeSplitter(payable(splitter)).sweepCurve(0);
        (uint256 owed,) = FeeSplitter(payable(splitter)).pending();
        console.log("swept into the escrow (wei):", owed);
        assertGt(owed, 0, "trading produced fees");
        FeeSplitter(payable(splitter)).harvestAll();
        vm.stopPrank();

        uint256 toX = claims.claimable(token, keccak256("x:44196397"), address(0));
        uint256 toTwitch = claims.claimable(token, keccak256("twitch:12826"), address(0));
        console.log("wallet :", WALLET.balance);
        console.log("x      :", toX);
        console.log("twitch :", toTwitch);
        assertEq(WALLET.balance + toX + toTwitch, owed, "every wei split");
        assertEq(WALLET.balance, owed * 2000 / 10_000, "wallet 20%");
        assertEq(toX, owed * 5000 / 10_000, "x 50%");
        assertEq(splitter.balance, 0, "nothing rests in the splitter");

        _claimX(token, toX, toTwitch);
    }

    /// The X account's owner claims to a wallet of their choosing with a server-signed voucher.
    function _claimX(address token, uint256 toX, uint256 toTwitch) internal {
        bytes32 ben = keccak256("x:44196397");
        uint256 deadline = block.timestamp + 900;
        bytes32 id = claims.voucherId(token, ben, address(0), PAYEE, toX, keccak256("s1"), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, id);
        vm.prank(PAYEE);
        claims.claim(token, ben, address(0), PAYEE, toX, keccak256("s1"), deadline, abi.encodePacked(r, s, v));
        assertEq(PAYEE.balance, toX, "claimed");
        assertEq(claims.claimable(token, ben, address(0)), 0);
        assertEq(claims.claimable(token, keccak256("twitch:12826"), address(0)), toTwitch, "twitch untouched");
    }

    function test_launchWithoutDevBuy() public {
        (address token,, address splitter) = _launch(0);
        assertTrue(token != address(0) && splitter != address(0));
        assertEq(pad.count(), 1);
        assertEq(pad.page(0, 10)[0].token, token);
    }
}
