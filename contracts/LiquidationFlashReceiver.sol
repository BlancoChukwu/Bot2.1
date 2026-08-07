// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC20 surface used by this receiver.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}

interface IPoolAddressesProvider {
    function getPriceOracle() external view returns (address);
}

/// @notice Aave V3 price oracle (USD base on Base; BASE_CURRENCY_UNIT = 1e8).
interface IPriceOracleGetter {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IAavePool {
    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);

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
    /// @dev Deploy-time default fee tier (informational / readiness). Per-tx fee comes from route params field 8.
    uint24 public immutable swapFee;
    uint256 public constant RECEIVER_VERSION = 5;
    uint256 internal constant BPS = 10_000;
    /// @dev Hard cap on owner-settable swap slippage (10%).
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 1_000;

    address private immutable _owner;
    address public authorizedInitiator;
    /// @dev Slippage tolerance applied to the on-chain oracle fair value of collateralBal (default 200 = 2%).
    uint256 public swapSlippageBps;

    error OnlyPool();
    error OnlyOwner();
    error UnauthorizedInitiator();
    error UnsupportedRouteType();
    error DebtAssetMismatch();
    error InsufficientDebtForRepay();
    error NoCollateralToSwap();
    error InvalidOraclePrice();
    error InvalidSwapSlippageBps();
    error InvalidSwapFee();

    event AuthorizedInitiatorUpdated(address indexed previous, address indexed next);
    event SwapSlippageBpsUpdated(uint256 previous, uint256 next);

    constructor(
        IAavePool pool_,
        ISwapRouter02 router_,
        uint24 swapFee_,
        address authorizedInitiator_,
        uint256 swapSlippageBps_
    ) {
        if (!_isValidFeeTier(swapFee_)) revert InvalidSwapFee();
        if (swapSlippageBps_ >= BPS || swapSlippageBps_ > MAX_SWAP_SLIPPAGE_BPS) {
            revert InvalidSwapSlippageBps();
        }
        POOL = pool_;
        SWAP_ROUTER = router_;
        swapFee = swapFee_;
        _owner = msg.sender;
        authorizedInitiator = authorizedInitiator_;
        swapSlippageBps = swapSlippageBps_;
        emit AuthorizedInitiatorUpdated(address(0), authorizedInitiator_);
        emit SwapSlippageBpsUpdated(0, swapSlippageBps_);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OnlyOwner();
        _;
    }

    function receiverVersion() external pure returns (uint256) {
        return RECEIVER_VERSION;
    }

    /// @notice Immutable owner set to `msg.sender` at deploy (gates rescue / initiator / slippage).
    function owner() external view returns (address) {
        return _owner;
    }

    function aavePool() external view returns (address) {
        return address(POOL);
    }

    function swapRouter() external view returns (address) {
        return address(SWAP_ROUTER);
    }

    function setAuthorizedInitiator(address next) external onlyOwner {
        emit AuthorizedInitiatorUpdated(authorizedInitiator, next);
        authorizedInitiator = next;
    }

    function setSwapSlippageBps(uint256 next) external onlyOwner {
        if (next >= BPS || next > MAX_SWAP_SLIPPAGE_BPS) revert InvalidSwapSlippageBps();
        emit SwapSlippageBpsUpdated(swapSlippageBps, next);
        swapSlippageBps = next;
    }

    /// @notice Pure decode helper for fork/integration tests (matches production TS encoder schema).
    function decodeRouteParams(bytes calldata params)
        external
        pure
        returns (
            uint8 routeType,
            address collateralAsset,
            address debtAsset,
            address user,
            uint256 debtToCover,
            uint256 minDebtOut,
            bool receiveAToken,
            uint24 fee
        )
    {
        return _decodeRouteParams(params);
    }

    /// @notice Live oracle fair-value floor for `collateralAmount` of `collateralAsset` in debt-asset wei.
    /// @dev Same math as the swap path (B1: ADDRESSES_PROVIDER → getPriceOracle each call).
    function oracleMinDebtOut(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount
    ) external view returns (uint256) {
        return _oracleMinDebtOut(collateralAsset, debtAsset, collateralAmount);
    }

    /// @notice Aave pulls `amount + premium` of `asset` after this returns; approve the pool for that sum.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert OnlyPool();
        if (initiator != authorizedInitiator) revert UnauthorizedInitiator();

        (
            uint8 routeType,
            address collateralAsset,
            address debtAsset,
            address user,
            uint256 debtToCover,
            uint256 minDebtOut,
            bool receiveAToken,
            uint24 fee
        ) = _decodeRouteParams(params);

        if (routeType != 0) revert UnsupportedRouteType();
        if (!_isValidFeeTier(fee)) revert InvalidSwapFee();
        // Field 6 (minDebtOut): decoded for schema compatibility with the production TS encoder.
        // Advisory / profitability-preview only — NEVER used as amountOutMinimum.
        // On-chain enforcement is the Aave-oracle floor over actual collateralBal (see _oracleMinDebtOut).
        // Do not "helpfully" wire this field into the swap; that was reviewed and rejected (PR 1/PR 2).
        minDebtOut;

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
            uint256 collateralBal = IERC20(collateralAsset).balanceOf(address(this));
            if (collateralBal == 0) revert NoCollateralToSwap();

            // Oracle floor on the FULL collateral being sold — not need*(1-slippage).
            // Do not min() against need: that collapses to need on profitable liquidations and
            // hands the bonus margin to a sandwicher.
            uint256 minOut = _oracleMinDebtOut(collateralAsset, asset, collateralBal);

            require(IERC20(collateralAsset).approve(address(SWAP_ROUTER), collateralBal), "approve router");
            SWAP_ROUTER.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: collateralAsset,
                    tokenOut: asset,
                    fee: fee,
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

    /// @dev Live B1 lookup: ADDRESSES_PROVIDER → getPriceOracle → getAssetPrice (no immutable oracle cache).
    function _oracleMinDebtOut(
        address collateralAsset,
        address debtAsset,
        uint256 collateralBal
    ) internal view returns (uint256) {
        IPriceOracleGetter oracle = IPriceOracleGetter(POOL.ADDRESSES_PROVIDER().getPriceOracle());
        uint256 priceCollateral = oracle.getAssetPrice(collateralAsset);
        uint256 priceDebt = oracle.getAssetPrice(debtAsset);
        if (priceCollateral == 0 || priceDebt == 0) revert InvalidOraclePrice();

        uint8 collateralDecimals = IERC20Metadata(collateralAsset).decimals();
        uint8 debtDecimals = IERC20Metadata(debtAsset).decimals();

        uint256 fairDebtOut = (collateralBal * priceCollateral * (10 ** uint256(debtDecimals)))
            / (priceDebt * (10 ** uint256(collateralDecimals)));
        uint256 minOut = (fairDebtOut * (BPS - swapSlippageBps)) / BPS;
        if (minOut == 0 && fairDebtOut > 0) {
            minOut = 1;
        }
        return minOut;
    }

    function _isValidFeeTier(uint24 fee) internal pure returns (bool) {
        return fee == 100 || fee == 500 || fee == 3_000 || fee == 10_000;
    }

    function _decodeRouteParams(bytes calldata params)
        internal
        pure
        returns (
            uint8 routeType,
            address collateralAsset,
            address debtAsset,
            address user,
            uint256 debtToCover,
            uint256 minDebtOut,
            bool receiveAToken,
            uint24 fee
        )
    {
        return abi.decode(params, (uint8, address, address, address, uint256, uint256, bool, uint24));
    }
}
