// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20V2 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH9 {
    function deposit() external payable;
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

/// @notice Moonwell / Compound-v2 mToken surface used by the Moonwell route.
interface IMErc20 {
    function liquidateBorrow(address borrower, uint256 repayAmount, address mTokenCollateral) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title MultiProtocolFlashReceiver
/// @notice Aave V3 `flashLoanSimple` callback. Route 0 = Aave V3 pool liquidation.
///         Route 1 = Moonwell Core `liquidateBorrow` + mToken redeem + wrap + swap.
///         Route 2 is reserved (reverts until a Morpho path is fork-proven).
contract MultiProtocolFlashReceiver {
    enum RouteType {
        AaveV3,
        Moonwell,
        Morpho
    }

    uint256 public constant RECEIVER_VERSION = 1;
    uint256 internal constant BPS = 10_000;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    IAavePoolV2 public immutable POOL;
    ISwapRouter02V2 public immutable SWAP_ROUTER;
    uint24 public immutable swapFee;
    address private immutable _owner;

    address public authorizedInitiator;
    mapping(address => address) public mTokenOf;

    error OnlyPool();
    error OnlyOwner();
    error UnauthorizedInitiator();
    error UnsupportedRouteType();
    error InsufficientDebtForRepay();
    error UnknownMoonwellMarket();
    error MoonwellLiquidateFailed(uint256 code);
    error MoonwellRedeemFailed(uint256 code);
    error NoCollateralToSwap();
    error ZeroAddress();

    constructor(
        IAavePoolV2 pool_,
        ISwapRouter02V2 router_,
        uint24 swapFee_,
        address authorizedInitiator_,
        address[] memory underlyings,
        address[] memory mTokens
    ) {
        if (address(pool_) == address(0) || address(router_) == address(0)) revert ZeroAddress();
        require(underlyings.length == mTokens.length, "mtoken length");
        POOL = pool_;
        SWAP_ROUTER = router_;
        swapFee = swapFee_;
        _owner = msg.sender;
        authorizedInitiator = authorizedInitiator_;
        for (uint256 i = 0; i < underlyings.length; i++) {
            if (underlyings[i] == address(0) || mTokens[i] == address(0)) revert ZeroAddress();
            mTokenOf[underlyings[i]] = mTokens[i];
        }
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OnlyOwner();
        _;
    }

    receive() external payable {}

    function receiverVersion() external pure returns (uint256) {
        return RECEIVER_VERSION;
    }

    function aavePool() external view returns (address) {
        return address(POOL);
    }

    function swapRouter() external view returns (address) {
        return address(SWAP_ROUTER);
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function setAuthorizedInitiator(address next) external onlyOwner {
        authorizedInitiator = next;
    }

    function setMToken(address underlying, address mToken) external onlyOwner {
        if (underlying == address(0) || mToken == address(0)) revert ZeroAddress();
        mTokenOf[underlying] = mToken;
    }

    /// @notice Production params: routeType, collateral, debt, user, debtToCover, minCollateralOut, receiveAToken.
    ///         `minCollateralOut` is the quote-based amountOutMinimum for the collateral -> debt swap.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert OnlyPool();
        if (authorizedInitiator != address(0) && initiator != authorizedInitiator) {
            revert UnauthorizedInitiator();
        }

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
        if (debtAsset != asset) {
            revert InsufficientDebtForRepay();
        }

        if (routeType == RouteType.AaveV3) {
            _liquidateAave(collateralAsset, debtAsset, user, debtToCover, receiveAToken);
        } else if (routeType == RouteType.Moonwell) {
            _liquidateMoonwell(collateralAsset, debtAsset, user, debtToCover);
        } else {
            revert UnsupportedRouteType();
        }

        _wrapNativeEth();
        _swapCollateralForDebt(collateralAsset, asset, minCollateralOut);

        uint256 owe = amount + premium;
        if (IERC20V2(asset).balanceOf(address(this)) < owe) revert InsufficientDebtForRepay();
        require(IERC20V2(asset).approve(address(POOL), owe), "approve pool repay");
        return true;
    }

    function _liquidateAave(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) internal {
        require(IERC20V2(debtAsset).approve(address(POOL), debtToCover), "approve pool liq");
        POOL.liquidationCall(collateralAsset, debtAsset, user, debtToCover, receiveAToken);
    }

    function _liquidateMoonwell(
        address collateralUnderlying,
        address debtUnderlying,
        address user,
        uint256 debtToCover
    ) internal {
        address mDebt = mTokenOf[debtUnderlying];
        address mCollateral = mTokenOf[collateralUnderlying];
        if (mDebt == address(0) || mCollateral == address(0)) revert UnknownMoonwellMarket();

        require(IERC20V2(debtUnderlying).approve(mDebt, debtToCover), "approve mDebt");
        uint256 liqErr = IMErc20(mDebt).liquidateBorrow(user, debtToCover, mCollateral);
        if (liqErr != 0) revert MoonwellLiquidateFailed(liqErr);

        uint256 seized = IMErc20(mCollateral).balanceOf(address(this));
        if (seized == 0) revert NoCollateralToSwap();
        uint256 redeemErr = IMErc20(mCollateral).redeem(seized);
        if (redeemErr != 0) revert MoonwellRedeemFailed(redeemErr);
    }

    /// @dev Moonwell mWETH redeem unwraps to native ETH. Wrap before the Uniswap swap.
    function _wrapNativeEth() internal {
        uint256 ethBal = address(this).balance;
        if (ethBal == 0) return;
        IWETH9(WETH).deposit{value: ethBal}();
    }

    function _swapCollateralForDebt(address collateralAsset, address debtAsset, uint256 minDebtOut) internal {
        if (collateralAsset == debtAsset) {
            return;
        }
        uint256 collateralBal = IERC20V2(collateralAsset).balanceOf(address(this));
        address tokenIn = collateralAsset;
        if (collateralBal == 0) {
            uint256 wethBal = IERC20V2(WETH).balanceOf(address(this));
            if (wethBal == 0) revert NoCollateralToSwap();
            tokenIn = WETH;
            collateralBal = wethBal;
        }
        require(IERC20V2(tokenIn).approve(address(SWAP_ROUTER), collateralBal), "approve router");
        uint256 amountOutMinimum = minDebtOut;
        if (amountOutMinimum == 0) {
            amountOutMinimum = 1;
        }
        SWAP_ROUTER.exactInputSingle(
            ISwapRouter02V2.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: debtAsset,
                fee: swapFee,
                recipient: address(this),
                amountIn: collateralBal,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
