// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FeesClaims} from "../src/FeesClaims.sol";
import {FeesLaunchpad, IPonsV2Factory} from "../src/FeesLaunchpad.sol";
import {IFeesClaims} from "../src/FeeSplitter.sol";

/**
 * Deploys FeesClaims then FeesLaunchpad, and reads every immutable back.
 *
 *   OWNER=0x… SIGNER=0x… forge script script/Deploy.s.sol --rpc-url … --broadcast
 *
 * ⚠ OWNER can pause claiming and rotate the signer; it can never take a credited balance.
 * ⚠ SIGNER is the voucher key the API holds. It moves no money by itself.
 */
contract Deploy is Script {
    address constant PONS_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;

    function run() external {
        address owner = vm.envAddress("OWNER");
        address signer = vm.envAddress("SIGNER");
        /* ⛔ The key comes from the environment, never `--private-key`, which any user sees in `ps`.
           And not ETH_PRIVATE_KEY: forge script ignores it and silently simulates with its default
           sender, broadcasting nothing (caught by deploy.sh's rehearsal on a fork). */
        vm.startBroadcast(vm.envUint("DEPLOYER_KEY"));
        FeesClaims claims = new FeesClaims(owner, signer);
        FeesLaunchpad pad = new FeesLaunchpad(IPonsV2Factory(PONS_FACTORY), IFeesClaims(address(claims)));
        vm.stopBroadcast();

        /* ⛔ Read back, never assumed. A swapped constructor pair ships a contract that looks fine. */
        require(claims.owner() == owner && claims.signer() == signer, "claims wired wrong");
        require(address(pad.claims()) == address(claims), "launchpad names the wrong claims");
        require(address(pad.factory()) == PONS_FACTORY, "launchpad names the wrong factory");
        console.log("FEES_CLAIMS=%s", address(claims));
        console.log("FEES_LAUNCHPAD=%s", address(pad));
    }
}
