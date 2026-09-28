// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "ALLOWANCE");
        allowance[from][msg.sender] = a - amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

interface IFlashReceiverLike {
    function executeOperation(address, uint256, uint256, address, bytes calldata) external returns (bool);
}

/// @dev Simplified Aave V3 Pool: flashLoanSimple + liquidationCall with configurable economics.
contract MockPool {
    uint256 public premiumBps = 5;
    // collateral out per debt in = num/den (already includes bonus & decimals)
    uint256 public collNum = 105;
    uint256 public collDen = 100;
    uint256 public maxLiquidatable = type(uint256).max;
    bool public useForcedInitiator;
    address public forcedInitiator;
    bool public reenter;
    bytes public reenterParams;

    function setEconomics(uint256 num, uint256 den, uint256 maxLiq) external {
        collNum = num;
        collDen = den;
        maxLiquidatable = maxLiq;
    }

    function setForcedInitiator(bool on, address who) external {
        useForcedInitiator = on;
        forcedInitiator = who;
    }

    function setReenter(bool on, bytes calldata p) external {
        reenter = on;
        reenterParams = p;
    }

    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16)
        external
    {
        uint256 premium = (amount * premiumBps) / 10_000;
        MockERC20(asset).transfer(receiver, amount);
        address initiator = useForcedInitiator ? forcedInitiator : msg.sender;
        require(
            IFlashReceiverLike(receiver).executeOperation(asset, amount, premium, initiator, params), "EXEC_FALSE"
        );
        MockERC20(asset).transferFrom(receiver, address(this), amount + premium);
    }

    function liquidationCall(address collateral, address debt, address, uint256 debtToCover, bool) external {
        if (reenter) {
            IFlashReceiverLike(msg.sender).executeOperation(debt, 1, 0, forcedInitiator, reenterParams);
        }
        uint256 actual = debtToCover > maxLiquidatable ? maxLiquidatable : debtToCover;
        MockERC20(debt).transferFrom(msg.sender, address(this), actual);
        uint256 out = (actual * collNum) / collDen;
        MockERC20(collateral).transfer(msg.sender, out);
    }
}

/// @dev Simplified SwapRouter02.exactInputSingle with a fixed rate.
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public rateNum = 1;
    uint256 public rateDen = 1;
    uint24 public lastFee;
    uint256 public lastAmountIn;
    uint256 public lastMinOut;

    function setRate(uint256 n, uint256 d) external {
        rateNum = n;
        rateDen = d;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        MockERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = (p.amountIn * rateNum) / rateDen;
        require(out >= p.amountOutMinimum, "Too little received");
        MockERC20(p.tokenOut).transfer(p.recipient, out);
        lastFee = p.fee;
        lastAmountIn = p.amountIn;
        lastMinOut = p.amountOutMinimum;
    }
}
