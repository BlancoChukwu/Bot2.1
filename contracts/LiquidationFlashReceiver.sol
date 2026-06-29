// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC20 surface used by this receiver.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IAavePool {
    function getUserAccountData(address user) external view returns (
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold,
        uint256 ltv,
        uint256 healthFactor
    );

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

/// @notice Uniswap V3 `SwapRouter02` on Base (no deadline in params).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title LiquidationFlashReceiver
/// @dev Aave V3 `flashLoanSimple` receiver: repay flash + premium by swapping received collateral to the debt asset.
contract LiquidationFlashReceiver {
    IAavePool public immutable POOL;
    ISwapRouter02 public immutable SWAP_ROUTER;
    uint24 public immutable swapFee;
    uint256 public constant RECEIVER_VERSION = 2;
    uint256 internal constant BPS = 10_000;
    /// @dev Max slippage on the collateral -> debt swap (200 = 2%).
    uint256 public constant SWAP_SLIPPAGE_BPS = 200;

    address private immutable _owner;

    error OnlyPool();
    error OnlyOwner();
    error DebtAssetMismatch();
    error InsufficientDebtForRepay();
    error NoCollateralToSwap();

    constructor(IAavePool pool_, ISwapRouter02 router_, uint24 swapFee_) {
        POOL = pool_;
        SWAP_ROUTER = router_;
        swapFee = swapFee_;
        _owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OnlyOwner();
        _;
    }

    function receiverVersion() external pure returns (uint256) {
        return RECEIVER_VERSION;
    }

    function aavePool() external view returns (address) {
        return address(POOL);
    }

    function swapRouter() external view returns (address) {
        return address(SWAP_ROUTER);
    }

    /// @notice Aave pulls `amount + premium` of `asset` after this returns; approve the pool for that sum.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert OnlyPool();

        (address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) =
            abi.decode(params, (address, address, address, uint256, bool));

        if (debtAsset != asset) revert DebtAssetMismatch();

        // Aave pulls `amount + premium` of `asset` after this call; `amount` was just transferred in.
        IERC20 debt = IERC20(asset);
        // Collateral-only path: debt and collateral are the same (extremely rare).
        if (collateralAsset == asset) {
            uint256 oweSame = amount + premium;
            if (debt.balanceOf(address(this)) < oweSame) revert InsufficientDebtForRepay();
            require(debt.approve(address(POOL), oweSame), "approve pool repay");
            return true;
        }

        require(debt.approve(address(POOL), debtToCover), "approve pool liq");

        (, , , , , uint256 hfBeforeLiq) = POOL.getUserAccountData(user);
        require(hfBeforeLiq < 1e18, "HF_NOT_LIQUIDATABLE");

        POOL.liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken);

        uint256 owe = amount + premium;
        uint256 debtBal = debt.balanceOf(address(this));
        if (debtBal < owe) {
            uint256 need = owe - debtBal;
            uint256 collateralBal = IERC20(collateralAsset).balanceOf(address(this));
            if (collateralBal == 0) revert NoCollateralToSwap();

            uint256 minOut = (need * (BPS - SWAP_SLIPPAGE_BPS)) / BPS;
            if (minOut == 0 && need > 0) {
                minOut = 1;
            }

            require(IERC20(collateralAsset).approve(address(SWAP_ROUTER), collateralBal), "approve router");
            SWAP_ROUTER.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: collateralAsset,
                    tokenOut: asset,
                    fee: swapFee,
                    recipient: address(this),
                    amountIn: collateralBal,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        debtBal = debt.balanceOf(address(this));
        if (debtBal < owe) {
            revert InsufficientDebtForRepay();
        }
        require(debt.approve(address(POOL), owe), "approve pool repay");
        return true;
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "rescue transfer");
    }
}
