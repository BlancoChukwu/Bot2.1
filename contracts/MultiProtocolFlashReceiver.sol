// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20V2 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAavePoolV2 {
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface ISwapRouter02V2 {
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

contract MultiProtocolFlashReceiver {
    enum RouteType {
        AaveV3,
        Moonwell,
        Morpho
    }

    IAavePoolV2 public immutable POOL;
    ISwapRouter02V2 public immutable SWAP_ROUTER;
    uint24 public immutable swapFee;
    address private immutable _owner;

    error OnlyPool();
    error UnsupportedRouteType();
    error InsufficientDebtForRepay();

    constructor(IAavePoolV2 pool_, ISwapRouter02V2 router_, uint24 swapFee_) {
        POOL = pool_;
        SWAP_ROUTER = router_;
        swapFee = swapFee_;
        _owner = msg.sender;
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert OnlyPool();

        (
            uint8 routeTypeRaw,
            address collateralAsset,
            address debtAsset,
            address user,
            uint256 debtToCover,
            uint256 minCollateralOut,
            bool receiveAToken
        ) = abi.decode(params, (uint8, address, address, address, uint256, uint256, bool));

        RouteType routeType = RouteType(routeTypeRaw);
        if (routeType == RouteType.AaveV3) {
            POOL.liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken);
            _swapCollateralForDebt(collateralAsset, asset, minCollateralOut);
        } else {
            revert UnsupportedRouteType();
        }

        uint256 owe = amount + premium;
        if (IERC20V2(asset).balanceOf(address(this)) < owe) revert InsufficientDebtForRepay();
        require(IERC20V2(asset).approve(address(POOL), owe), "approve pool repay");
        return true;
    }

    function _swapCollateralForDebt(address collateralAsset, address debtAsset, uint256 minDebtOut) internal {
        uint256 collateralBal = IERC20V2(collateralAsset).balanceOf(address(this));
        require(collateralBal > 0, "no collateral");
        require(IERC20V2(collateralAsset).approve(address(SWAP_ROUTER), collateralBal), "approve router");
        ISwapRouter02V2.ExactInputSingleParams memory p = ISwapRouter02V2.ExactInputSingleParams({
            tokenIn: collateralAsset,
            tokenOut: debtAsset,
            fee: swapFee,
            recipient: address(this),
            amountIn: collateralBal,
            amountOutMinimum: minDebtOut,
            sqrtPriceLimitX96: 0
        });
        SWAP_ROUTER.exactInputSingle(p);
    }
}

