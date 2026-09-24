// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeSplitter, IPonsFeeEscrow, IFeesClaims} from "../src/FeeSplitter.sol";
import {FeesClaims} from "../src/FeesClaims.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

contract MockEscrow {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public balanceOfToken;

    function credit(address r) external payable { balanceOf[r] += msg.value; }

    function creditToken(address r, address t, uint256 a) external {
        ERC20(t).transferFrom(msg.sender, address(this), a);
        balanceOfToken[r][t] += a;
    }

    function claim() external returns (uint256 a) {
        a = balanceOf[msg.sender];
        require(a > 0, "nothing");
        balanceOf[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: a}("");
        require(ok);
    }

    function claimToken(address t) external returns (uint256 a) {
        a = balanceOfToken[msg.sender][t];
        require(a > 0, "nothing");
        balanceOfToken[msg.sender][t] = 0;
        ERC20(t).transfer(msg.sender, a);
    }
}

contract Tok is ERC20 {
    constructor() ERC20("T", "T") { _mint(msg.sender, 1e30); }
}

contract Refuser {
    receive() external payable { revert("no"); }
}

/// Tries to re-enter the splitter when paid.
contract Reenterer {
    FeeSplitter public target;
    bool public tried;
    bool public blocked;
    function set(FeeSplitter t) external { target = t; }
    receive() external payable {
        if (tried) return;
        tried = true;
        try target.distribute(address(0)) {} catch { blocked = true; }
    }
}

contract FeeSplitterTest is Test {
    MockEscrow escrow;
    FeesClaims claims;
    Tok usd;

    address constant ALICE = address(0xA11CE);
    uint256 constant X_ID = 44196397;
    uint256 constant TW_ID = 12826;
    uint256 constant GH_ID = 583231;
    address TOKEN;
    address constant CURVE = address(0xC0C0);

    function setUp() public {
        escrow = new MockEscrow();
        claims = new FeesClaims(address(this), address(0x5165));
        usd = new Tok();
        TOKEN = address(new Tok());
    }

    function _b(string memory s) internal pure returns (bytes32) { return keccak256(bytes(s)); }

    function _shares() internal pure returns (FeeSplitter.Share[] memory s) {
        s = new FeeSplitter.Share[](4);
        s[0] = FeeSplitter.Share(0, 4000, ALICE, 0, bytes32(0));
        s[1] = FeeSplitter.Share(1, 3000, address(0), X_ID, keccak256("x:44196397"));
        s[2] = FeeSplitter.Share(3, 2000, address(0), TW_ID, keccak256("twitch:12826"));
        s[3] = FeeSplitter.Share(2, 1000, address(0), GH_ID, keccak256("github:583231"));
    }

    function _make(FeeSplitter.Share[] memory s, address pair) internal returns (FeeSplitter sp) {
        sp = new FeeSplitter(IPonsFeeEscrow(address(escrow)), IFeesClaims(address(claims)), s);
        sp.initialize(TOKEN, CURVE, pair);
    }

    function test_nativeFeesSplitAcrossWalletsAndAllThreeProviders() public {
        FeeSplitter sp = _make(_shares(), address(0));
        escrow.credit{value: 1 ether}(address(sp));
        vm.prank(address(0xdead));
        sp.harvestAll();

        assertEq(ALICE.balance, 0.4 ether, "wallet");
        assertEq(claims.claimable(TOKEN, _b("x:44196397"), address(0)), 0.3 ether, "x");
        assertEq(claims.claimable(TOKEN, _b("twitch:12826"), address(0)), 0.2 ether, "twitch");
        assertEq(claims.claimable(TOKEN, _b("github:583231"), address(0)), 0.1 ether, "github");
        assertEq(address(sp).balance, 0, "nothing rests");
        assertEq(sp.totalToWallets(address(0)), 0.4 ether);
        assertEq(sp.totalToAccounts(address(0)), 0.6 ether);
    }

    function test_pairTokenFeesSplitAndLeaveNoAllowance() public {
        FeeSplitter sp = _make(_shares(), address(usd));
        usd.approve(address(escrow), type(uint256).max);
        escrow.creditToken(address(sp), address(usd), 1000e18);
        sp.harvestAll();
        assertEq(usd.balanceOf(ALICE), 400e18);
        assertEq(claims.claimable(TOKEN, _b("twitch:12826"), address(usd)), 200e18);
        assertEq(usd.allowance(address(sp), address(claims)), 0, "no standing approval");
        assertEq(usd.balanceOf(address(sp)), 0);
    }

    function test_dustLandsOnTheLastShare() public {
        FeeSplitter sp = _make(_shares(), address(0));
        vm.deal(address(sp), 7);
        sp.distribute(address(0));
        assertEq(address(sp).balance, 0, "every wei left");
    }

    function test_aRefusingWalletIsParkedAndDoesNotBlockTheOthers() public {
        Refuser r = new Refuser();
        FeeSplitter.Share[] memory s = new FeeSplitter.Share[](2);
        s[0] = FeeSplitter.Share(0, 5000, address(r), 0, bytes32(0));
        s[1] = FeeSplitter.Share(1, 5000, address(0), X_ID, keccak256("x:44196397"));
        FeeSplitter sp = _make(s, address(0));
        vm.deal(address(sp), 1 ether);
        sp.distribute(address(0));
        assertEq(claims.claimable(TOKEN, _b("x:44196397"), address(0)), 0.5 ether, "the account was still paid");
        assertEq(sp.parked(address(r), address(0)), 0.5 ether);
        // ⛔ parked money is not split again
        sp.distribute(address(0));
        assertEq(claims.claimable(TOKEN, _b("x:44196397"), address(0)), 0.5 ether, "not double split");
    }

    function test_reentryIsRefused() public {
        Reenterer r = new Reenterer();
        FeeSplitter.Share[] memory s = new FeeSplitter.Share[](2);
        s[0] = FeeSplitter.Share(0, 5000, address(r), 0, bytes32(0));
        s[1] = FeeSplitter.Share(0, 5000, ALICE, 0, bytes32(0));
        FeeSplitter sp = _make(s, address(0));
        r.set(sp);
        vm.deal(address(sp), 1 ether);
        sp.distribute(address(0));
        assertTrue(r.blocked(), "re-entry was refused");
        assertEq(ALICE.balance, 0.5 ether);
        assertEq(address(r).balance, 0.5 ether);
    }

    function test_declaredAccountMustMatchItsHash() public {
        FeeSplitter.Share[] memory s = new FeeSplitter.Share[](1);
        // declares twitch 12826, pays the hash of x:12826
        s[0] = FeeSplitter.Share(3, 10_000, address(0), TW_ID, keccak256("x:12826"));
        vm.expectRevert();
        new FeeSplitter(IPonsFeeEscrow(address(escrow)), IFeesClaims(address(claims)), s);
    }

    function test_sharesMustAddToExactlyTenThousand() public {
        FeeSplitter.Share[] memory s = new FeeSplitter.Share[](1);
        s[0] = FeeSplitter.Share(0, 9_999, ALICE, 0, bytes32(0));
        vm.expectRevert(FeeSplitter.BadShares.selector);
        new FeeSplitter(IPonsFeeEscrow(address(escrow)), IFeesClaims(address(claims)), s);
    }

    function test_unknownProviderRefused() public {
        FeeSplitter.Share[] memory s = new FeeSplitter.Share[](1);
        s[0] = FeeSplitter.Share(4, 10_000, address(0), 5, keccak256("x:5"));
        vm.expectRevert(FeeSplitter.BadShares.selector);
        new FeeSplitter(IPonsFeeEscrow(address(escrow)), IFeesClaims(address(claims)), s);
    }

    function test_onlyTheLaunchpadBindsItOnce() public {
        FeeSplitter sp = new FeeSplitter(IPonsFeeEscrow(address(escrow)), IFeesClaims(address(claims)), _shares());
        vm.prank(address(0xbad));
        vm.expectRevert(FeeSplitter.NotLaunchpad.selector);
        sp.initialize(TOKEN, CURVE, address(0));
        sp.initialize(TOKEN, CURVE, address(0));
        vm.expectRevert(FeeSplitter.AlreadyInitialized.selector);
        sp.initialize(address(1), CURVE, address(0));
    }

    function test_nothingDistributesBeforeBinding() public {
        FeeSplitter sp = new FeeSplitter(IPonsFeeEscrow(address(escrow)), IFeesClaims(address(claims)), _shares());
        vm.deal(address(sp), 1 ether);
        vm.expectRevert(FeeSplitter.NotInitialized.selector);
        sp.distribute(address(0));
    }
}
