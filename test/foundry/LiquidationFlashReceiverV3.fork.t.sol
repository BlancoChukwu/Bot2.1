// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {
    LiquidationFlashReceiverV3,
    IAavePoolV3,
    ISwapRouter02V3
} from "../../contracts/LiquidationFlashReceiverV3.sol";

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IPoolF {
    function ADDRESSES_PROVIDER() external view returns (address);
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 rateMode, uint16 referralCode, address onBehalfOf)
        external;
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 ref)
        external;
    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
}

interface IAddressesProviderF {
    function getPriceOracle() external view returns (address);
}

interface IOracleF {
    function getAssetPrice(address asset) external view returns (uint256);
}

/// @notice Base-mainnet fork E2E. Run with:
///   FORK_URL=https://mainnet.base.org FORK_BLOCK=<n> forge test --match-contract Fork -vv
/// Skips (passes trivially) when FORK_URL is unset. Nothing is broadcast; everything runs in-memory.
contract LiquidationFlashReceiverV3ForkTest is Test {
    address constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant EXPECTED_ORACLE = 0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156;

    LiquidationFlashReceiverV3 recv;
    address owner = makeAddr("owner");
    address executor = makeAddr("executorEOA");
    address recipient = makeAddr("profitRecipient");
    address borrower = makeAddr("borrower");
    address oracle;
    bool forked;
    uint256 borrowed;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, blk);
        forked = true;

        oracle = IAddressesProviderF(IPoolF(POOL).ADDRESSES_PROVIDER()).getPriceOracle();
        assertEq(oracle, EXPECTED_ORACLE, "oracle address");

        uint256 g0 = gasleft();
        recv = new LiquidationFlashReceiverV3(
            IAavePoolV3(POOL), ISwapRouter02V3(ROUTER), owner, executor, recipient
        );
        console2.log("deploy gas (in-EVM, excl. intrinsic+calldata)", g0 - gasleft());
        console2.log("runtime code size", address(recv).code.length);
        vm.prank(owner);
        recv.setPoolFee(WETH, USDC, 500);

        // Borrower: supply 10 WETH, borrow USDC near max.
        deal(WETH, borrower, 10 ether);
        vm.startPrank(borrower);
        IERC20F(WETH).approve(POOL, type(uint256).max);
        IPoolF(POOL).supply(WETH, 10 ether, borrower, 0);
        (,, uint256 availBase,,,) = IPoolF(POOL).getUserAccountData(borrower);
        borrowed = (availBase * 99 / 100) / 100; // base (8dp USD) -> USDC 6dp
        IPoolF(POOL).borrow(USDC, borrowed, 2, 0, borrower);
        vm.stopPrank();

        (,,,,, uint256 hf) = IPoolF(POOL).getUserAccountData(borrower);
        console2.log("HF after borrow (1e18)", hf);
        console2.log("borrowed USDC", borrowed);

        // Drop WETH oracle price 15% so HF < 1.
        uint256 px = IOracleF(oracle).getAssetPrice(WETH);
        vm.mockCall(
            oracle, abi.encodeWithSelector(IOracleF.getAssetPrice.selector, WETH), abi.encode(px * 85 / 100)
        );
        (,,,,, hf) = IPoolF(POOL).getUserAccountData(borrower);
        console2.log("WETH oracle px (8dp) real", px);
        console2.log("HF after oracle drop (1e18)", hf);
        assertLt(hf, 1e18, "not liquidatable");
    }

    function _params(uint256 dtc, uint256 minOut) internal view returns (bytes memory) {
        return abi.encode(uint8(0), WETH, USDC, borrower, dtc, minOut, false);
    }

    function _assertClean() internal view {
        assertEq(IERC20F(USDC).balanceOf(address(recv)), 0, "recv USDC");
        assertEq(IERC20F(WETH).balanceOf(address(recv)), 0, "recv WETH");
        assertEq(IERC20F(USDC).allowance(address(recv), POOL), 0, "USDC->pool allowance");
        assertEq(IERC20F(WETH).allowance(address(recv), ROUTER), 0, "WETH->router allowance");
    }

    function test_fork_directPoolFlash_liquidates_repays_sweeps() public {
        if (!forked) return;
        uint256 dtc = borrowed / 2;
        (, uint256 debtBefore,,,,) = IPoolF(POOL).getUserAccountData(borrower);
        uint256 g0 = gasleft();
        vm.prank(executor, executor); // TS path: bot EOA calls Pool.flashLoanSimple directly
        IPoolF(POOL).flashLoanSimple(address(recv), USDC, dtc, _params(dtc, 0), 0);
        uint256 used = g0 - gasleft();
        (, uint256 debtAfter,,,, uint256 hfAfter) = IPoolF(POOL).getUserAccountData(borrower);
        uint256 profit = IERC20F(USDC).balanceOf(recipient);
        console2.log("E2E direct flashLoanSimple gas (in-EVM)", used);
        console2.log("debtToCover USDC", dtc);
        console2.log("profit swept USDC", profit);
        console2.log("borrower debt base before/after", debtBefore, debtAfter);
        console2.log("HF after liquidation", hfAfter);
        assertLt(debtAfter, debtBefore, "debt not reduced");
        assertGt(profit, 0, "no profit swept");
        _assertClean();
    }

    function test_fork_liquidateEntry() public {
        if (!forked) return;
        uint256 dtc = borrowed / 4;
        uint256 g0 = gasleft();
        vm.prank(executor, executor);
        recv.liquidate(WETH, USDC, borrower, dtc, 0);
        console2.log("E2E liquidate() entry gas (in-EVM)", g0 - gasleft());
        console2.log("profit swept USDC", IERC20F(USDC).balanceOf(recipient));
        assertGt(IERC20F(USDC).balanceOf(recipient), 0);
        _assertClean();
    }

    function test_fork_minOutTooHigh_reverts() public {
        if (!forked) return;
        uint256 dtc = borrowed / 2;
        // sandwich guard: demand far more USDC than the swap can return
        vm.prank(executor, executor);
        vm.expectRevert(bytes("Too little received"));
        IPoolF(POOL).flashLoanSimple(address(recv), USDC, dtc, _params(dtc, dtc * 2), 0);
    }

    function test_fork_strangerInitiator_reverts() public {
        if (!forked) return;
        uint256 dtc = borrowed / 2;
        address stranger = makeAddr("stranger");
        vm.prank(stranger, stranger);
        vm.expectRevert(LiquidationFlashReceiverV3.UnauthorizedInitiator.selector);
        IPoolF(POOL).flashLoanSimple(address(recv), USDC, dtc, _params(dtc, 0), 0);
    }

    function test_fork_feeUnset_reverts() public {
        if (!forked) return;
        vm.prank(owner);
        recv.setPoolFee(WETH, USDC, 0);
        uint256 dtc = borrowed / 2;
        vm.prank(executor, executor);
        vm.expectRevert(abi.encodeWithSelector(LiquidationFlashReceiverV3.FeeNotSet.selector, WETH, USDC));
        IPoolF(POOL).flashLoanSimple(address(recv), USDC, dtc, _params(dtc, 0), 0);
    }
}
