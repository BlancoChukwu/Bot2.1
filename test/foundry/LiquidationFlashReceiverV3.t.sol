// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    LiquidationFlashReceiverV3,
    IAavePoolV3,
    ISwapRouter02V3
} from "../../contracts/LiquidationFlashReceiverV3.sol";
import {MockERC20, MockPool, MockRouter} from "./mocks/ReceiverV3Mocks.sol";

contract LiquidationFlashReceiverV3UnitTest is Test {
    LiquidationFlashReceiverV3 internal recv;
    MockPool internal pool;
    MockRouter internal router;
    MockERC20 internal debt;
    MockERC20 internal coll;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal attacker = makeAddr("attacker");
    address internal borrower = makeAddr("borrower");

    uint256 internal constant AMOUNT = 1_000e18;
    uint256 internal constant PREMIUM = (AMOUNT * 5) / 10_000; // 0.5e18
    uint256 internal constant OWE = AMOUNT + PREMIUM;

    event LiquidationExecuted(
        address indexed user,
        address indexed collateral,
        address indexed debt,
        uint256 debtCovered,
        uint256 collateralReceived,
        uint256 profit
    );

    function setUp() public {
        pool = new MockPool();
        router = new MockRouter();
        debt = new MockERC20("Debt", "DEBT", 18);
        coll = new MockERC20("Coll", "COLL", 18);
        debt.mint(address(pool), 1_000_000e18);
        coll.mint(address(pool), 1_000_000e18);
        debt.mint(address(router), 1_000_000e18);
        coll.mint(address(router), 1_000_000e18);
        recv = new LiquidationFlashReceiverV3(
            IAavePoolV3(address(pool)), ISwapRouter02V3(address(router)), owner, executor, recipient
        );
        vm.prank(owner);
        recv.setPoolFee(address(coll), address(debt), 500);
    }

    function _params(uint8 routeType, address c, address d, uint256 dtc, uint256 minOut, bool rat)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(routeType, c, d, borrower, dtc, minOut, rat);
    }

    function _good() internal view returns (bytes memory) {
        return _params(0, address(coll), address(debt), AMOUNT, 0, false);
    }

    function _flash(address caller, bytes memory p) internal {
        vm.prank(caller);
        pool.flashLoanSimple(address(recv), address(debt), AMOUNT, p, 0);
    }

    function _assertClean() internal view {
        assertEq(debt.balanceOf(address(recv)), 0, "recv debt bal");
        assertEq(coll.balanceOf(address(recv)), 0, "recv coll bal");
        assertEq(debt.allowance(address(recv), address(pool)), 0, "pool allowance");
        assertEq(coll.allowance(address(recv), address(router)), 0, "router allowance");
        assertEq(debt.allowance(address(recv), address(router)), 0, "router debt allowance");
    }

    // ---------------------------------------------------------------- identity / constructor
    function test_identity() public view {
        assertEq(recv.receiverVersion(), 3);
        assertEq(recv.layoutId(), keccak256("BOT21_RECEIVER_V3_7FIELD"));
        assertEq(recv.aavePool(), address(pool));
        assertEq(recv.swapRouter(), address(router));
        assertEq(recv.owner(), owner);
        assertEq(recv.executor(), executor);
        assertEq(recv.profitRecipient(), recipient);
    }

    function test_constructor_revertsOnAnyZero() public {
        IAavePoolV3 p = IAavePoolV3(address(pool));
        ISwapRouter02V3 r = ISwapRouter02V3(address(router));
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        new LiquidationFlashReceiverV3(IAavePoolV3(address(0)), r, owner, executor, recipient);
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        new LiquidationFlashReceiverV3(p, ISwapRouter02V3(address(0)), owner, executor, recipient);
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        new LiquidationFlashReceiverV3(p, r, address(0), executor, recipient);
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        new LiquidationFlashReceiverV3(p, r, owner, address(0), recipient);
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        new LiquidationFlashReceiverV3(p, r, owner, executor, address(0));
    }

    // ---------------------------------------------------------------- admin
    function test_setters_onlyOwner_and_nonZero() public {
        vm.startPrank(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyOwner.selector);
        recv.setExecutor(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyOwner.selector);
        recv.setProfitRecipient(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyOwner.selector);
        recv.setPoolFee(address(coll), address(debt), 3000);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyOwner.selector);
        recv.transferOwnership(attacker);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        recv.setExecutor(address(0));
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        recv.setProfitRecipient(address(0));
        vm.expectRevert(LiquidationFlashReceiverV3.InvalidFee.selector);
        recv.setPoolFee(address(coll), address(debt), 1_000_000);
        recv.setExecutor(attacker);
        assertEq(recv.executor(), attacker);
        vm.stopPrank();
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("next");
        vm.prank(owner);
        recv.transferOwnership(next);
        assertEq(recv.owner(), owner);
        vm.prank(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyPendingOwner.selector);
        recv.acceptOwnership();
        vm.prank(next);
        recv.acceptOwnership();
        assertEq(recv.owner(), next);
        assertEq(recv.pendingOwner(), address(0));
    }

    // ---------------------------------------------------------------- gates
    function test_onlyPool() public {
        vm.prank(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyPool.selector);
        recv.executeOperation(address(debt), AMOUNT, PREMIUM, executor, _good());
    }

    function test_initiatorGate_rejectsStranger() public {
        // attacker opens a flash loan into our receiver with their own params (v1 drain vector)
        vm.expectRevert(LiquidationFlashReceiverV3.UnauthorizedInitiator.selector);
        _flash(attacker, _good());
    }

    function test_initiatorGate_failsClosedOnZero() public {
        pool.setForcedInitiator(true, address(0));
        vm.expectRevert(LiquidationFlashReceiverV3.UnauthorizedInitiator.selector);
        _flash(executor, _good());
    }

    function test_initiatorGate_selfOnlyInsideLiquidate() public {
        pool.setForcedInitiator(true, address(recv));
        vm.expectRevert(LiquidationFlashReceiverV3.UnauthorizedInitiator.selector);
        _flash(attacker, _good());
    }

    function test_liquidate_onlyExecutor() public {
        vm.prank(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyExecutor.selector);
        recv.liquidate(address(coll), address(debt), borrower, AMOUNT, 0);
    }

    function test_reentrancy_blocked() public {
        // mock pool re-enters executeOperation from inside liquidationCall, claiming initiator=executor
        pool.setReenter(true, _good());
        pool.setForcedInitiator(false, executor);
        vm.expectRevert(LiquidationFlashReceiverV3.Reentrancy.selector);
        _flash(executor, _good());
    }

    // ---------------------------------------------------------------- param validation
    function test_routeTypeNonZero_reverts() public {
        for (uint8 rt = 1; rt < 4; rt++) {
            vm.expectRevert(abi.encodeWithSelector(LiquidationFlashReceiverV3.UnsupportedRouteType.selector, rt));
            _flash(executor, _params(rt, address(coll), address(debt), AMOUNT, 0, false));
        }
    }

    function test_receiveAToken_reverts() public {
        vm.expectRevert(LiquidationFlashReceiverV3.ReceiveATokenUnsupported.selector);
        _flash(executor, _params(0, address(coll), address(debt), AMOUNT, 0, true));
    }

    function test_debtAssetMismatch_reverts() public {
        vm.expectRevert(LiquidationFlashReceiverV3.DebtAssetMismatch.selector);
        _flash(executor, _params(0, address(debt), address(coll), AMOUNT, 0, false));
    }

    function test_debtToCoverAboveFlash_reverts() public {
        vm.expectRevert(LiquidationFlashReceiverV3.DebtToCoverExceedsFlash.selector);
        _flash(executor, _params(0, address(coll), address(debt), AMOUNT + 1, 0, false));
    }

    function test_feeUnset_reverts() public {
        vm.prank(owner);
        recv.setPoolFee(address(coll), address(debt), 0);
        vm.expectRevert(
            abi.encodeWithSelector(LiquidationFlashReceiverV3.FeeNotSet.selector, address(coll), address(debt))
        );
        _flash(executor, _good());
    }

    // ---------------------------------------------------------------- happy paths
    function test_directPoolPath_sweepsProfit_andLeavesZero() public {
        uint256 expectedColl = (AMOUNT * 105) / 100;
        uint256 expectedProfit = expectedColl - OWE; // router 1:1
        vm.expectEmit(true, true, true, true, address(recv));
        emit LiquidationExecuted(borrower, address(coll), address(debt), AMOUNT, expectedColl, expectedProfit);
        _flash(executor, _good());
        assertEq(debt.balanceOf(recipient), expectedProfit, "profit swept");
        assertEq(router.lastFee(), 500, "fee from mapping");
        assertEq(router.lastAmountIn(), expectedColl, "swap exactly received collateral");
        assertEq(router.lastMinOut(), OWE, "floor = owe when minOut below owe");
        _assertClean();
    }

    function test_liquidateEntry_worksAndLeavesZero() public {
        vm.prank(executor);
        recv.liquidate(address(coll), address(debt), borrower, AMOUNT, 0);
        assertEq(debt.balanceOf(recipient), (AMOUNT * 105) / 100 - OWE);
        _assertClean();
    }

    function test_minOutAboveOwe_isUsedAsFloor() public {
        uint256 minOut = OWE + 10e18;
        _flash(executor, _params(0, address(coll), address(debt), AMOUNT, minOut, false));
        assertEq(router.lastMinOut(), minOut);
        _assertClean();
    }

    function test_minOutTooHigh_reverts() public {
        uint256 minOut = (AMOUNT * 105) / 100 + 1; // more than the swap can return
        vm.expectRevert(bytes("Too little received"));
        _flash(executor, _params(0, address(coll), address(debt), AMOUNT, minOut, false));
    }

    function test_partialLiquidation_resetsAllowance_andSweepsLeftoverFlash() public {
        uint256 cap = 400e18;
        pool.setEconomics(105, 100, cap);
        // swap: 420 coll -> needs >= OWE; make router generous so swap alone covers owe
        router.setRate(3, 1);
        _flash(executor, _good());
        uint256 received = (cap * 105) / 100;
        uint256 swapOut = received * 3;
        uint256 expectedProfit = (AMOUNT - cap) + swapOut - OWE;
        assertEq(debt.balanceOf(recipient), expectedProfit);
        _assertClean();
    }

    function test_partialLiquidation_swapMustCoverOweAlone() public {
        // leftover flash (600) + swap (420) would cover owe, but swap alone does not -> revert
        pool.setEconomics(105, 100, 400e18);
        vm.expectRevert(bytes("Too little received"));
        _flash(executor, _good());
    }

    function test_sameAsset_callsLiquidation_andSweeps() public {
        vm.prank(owner);
        recv.setPoolFee(address(debt), address(debt), 0); // no swap needed / used
        _flash(executor, _params(0, address(debt), address(debt), AMOUNT, 0, false));
        uint256 received = (AMOUNT * 105) / 100;
        assertEq(debt.balanceOf(recipient), received - OWE);
        assertEq(router.lastAmountIn(), 0, "no swap");
        _assertClean();
    }

    function test_sameAsset_insufficientReceived_reverts() public {
        pool.setEconomics(1, 1, type(uint256).max); // received == amount < owe
        vm.expectRevert(
            abi.encodeWithSelector(LiquidationFlashReceiverV3.InsufficientRepay.selector, AMOUNT, OWE)
        );
        _flash(executor, _params(0, address(debt), address(debt), AMOUNT, 0, false));
    }

    function test_preexistingBalance_cannotCoverShortfall_andIsNotSwept() public {
        // receiver holds idle funds; swap returns less than owe -> must revert (v1 would succeed)
        debt.mint(address(recv), 5_000e18);
        coll.mint(address(recv), 5_000e18);
        router.setRate(90, 100); // 1050 coll -> 945 debt < owe
        vm.expectRevert(bytes("Too little received"));
        _flash(executor, _good());

        // with a good rate, preexisting balances stay put (only the delta is swept / swapped)
        router.setRate(1, 1);
        _flash(executor, _good());
        assertEq(debt.balanceOf(address(recv)), 5_000e18, "preexisting debt untouched");
        assertEq(coll.balanceOf(address(recv)), 5_000e18, "preexisting coll untouched");
        assertEq(router.lastAmountIn(), (AMOUNT * 105) / 100, "only delta swapped");
        assertEq(debt.balanceOf(recipient), (AMOUNT * 105) / 100 - OWE);
    }

    // ---------------------------------------------------------------- rescue / ETH
    function test_rescue_onlyOwner_erc20_and_eth() public {
        debt.mint(address(recv), 7e18);
        vm.deal(address(recv), 1 ether); // forced ETH (selfdestruct/coinbase) is still recoverable
        vm.prank(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyOwner.selector);
        recv.rescue(address(debt), attacker, 7e18);
        vm.prank(attacker);
        vm.expectRevert(LiquidationFlashReceiverV3.OnlyOwner.selector);
        recv.rescue(address(0), attacker, 1 ether);

        address to = makeAddr("safe");
        vm.startPrank(owner);
        recv.rescue(address(debt), to, 7e18);
        recv.rescue(address(0), to, 1 ether);
        vm.expectRevert(LiquidationFlashReceiverV3.ZeroAddress.selector);
        recv.rescue(address(debt), address(0), 1);
        vm.stopPrank();
        assertEq(debt.balanceOf(to), 7e18);
        assertEq(to.balance, 1 ether);
    }

    function test_plainEthTransfer_reverts() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(recv).call{value: 1 ether}("");
        assertFalse(ok, "no receive()");
    }
}
