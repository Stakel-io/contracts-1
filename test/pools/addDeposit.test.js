const {
  BN,
  ether,
  constants,
  expectRevert
} = require('@openzeppelin/test-helpers');
const { deployAllProxies } = require('../../deployments');
const {
  getNetworkConfig,
  deployLogicContracts
} = require('../../deployments/common');
const { initialSettings } = require('../../deployments/settings');
const { deployVRC } = require('../../deployments/vrc');
const {
  getDepositAmount,
  checkDepositAdded,
  removeNetworkFile,
  checkCollectorBalance
} = require('../utils');

const Deposits = artifacts.require('Deposits');
const Pools = artifacts.require('Pools');

const validatorDepositAmount = new BN(initialSettings.validatorDepositAmount);

contract('Pools', ([_, admin, sender1, withdrawer1, sender2, withdrawer2]) => {
  let networkConfig;
  let deposits;
  let vrc;
  let pools;

  before(async () => {
    networkConfig = await getNetworkConfig();
    await deployLogicContracts({ networkConfig });
    vrc = await deployVRC({ from: admin });
  });

  after(() => {
    removeNetworkFile(networkConfig.network);
  });

  beforeEach(async () => {
    let { deposits: depositsProxy, pools: poolsProxy } = await deployAllProxies(
      { initialAdmin: admin, networkConfig, vrc: vrc.options.address }
    );
    pools = await Pools.at(poolsProxy);
    deposits = await Deposits.at(depositsProxy);
  });

  it('fails to add a deposit with zero withdraw address', async () => {
    await expectRevert(
      pools.addDeposit(constants.ZERO_ADDRESS, {
        from: sender1
      }),
      'Withdraw address cannot be zero address.'
    );
    await checkCollectorBalance(pools, new BN(0));
  });

  it('fails to add a deposit without any amount', async () => {
    await expectRevert(
      pools.addDeposit(withdrawer1, {
        from: sender1,
        value: ether('0')
      }),
      'Deposit amount cannot be zero.'
    );
    await checkCollectorBalance(pools, new BN(0));
  });

  it('fails to add a deposit with unit less than minimal', async () => {
    await expectRevert(
      pools.addDeposit(withdrawer1, {
        from: sender1,
        value: new BN(initialSettings.validatorDepositAmount).sub(new BN(1))
      }),
      'Invalid deposit amount unit.'
    );
    await checkCollectorBalance(pools, new BN(0));
  });

  it('adds a deposit smaller than validator deposit amount', async () => {
    const depositAmount = getDepositAmount({
      max: validatorDepositAmount
    });
    // Send a deposit
    const { tx } = await pools.addDeposit(withdrawer1, {
      from: sender1,
      value: depositAmount
    });

    // Check deposit added to Deposits contract
    await checkDepositAdded({
      transaction: tx,
      depositsContract: deposits,
      collectorAddress: pools.address,
      entityId: new BN(1),
      senderAddress: sender1,
      withdrawalAddress: withdrawer1,
      addedAmount: depositAmount,
      totalAmount: depositAmount
    });

    // Check pools balance
    await checkCollectorBalance(pools, depositAmount);
  });

  it('adds a deposit bigger than validator deposit amount', async () => {
    const depositAmount = getDepositAmount({
      min: validatorDepositAmount,
      max: validatorDepositAmount.mul(new BN(2))
    });

    // Send a deposit
    const { tx } = await pools.addDeposit(withdrawer1, {
      from: sender1,
      value: depositAmount
    });

    // Check added to the pool 1
    await checkDepositAdded({
      transaction: tx,
      depositsContract: deposits,
      collectorAddress: pools.address,
      entityId: new BN(1),
      senderAddress: sender1,
      withdrawalAddress: withdrawer1,
      addedAmount: validatorDepositAmount,
      totalAmount: validatorDepositAmount
    });

    // Check added to the pool 2
    await checkDepositAdded({
      transaction: tx,
      depositsContract: deposits,
      collectorAddress: pools.address,
      entityId: new BN(2),
      senderAddress: sender1,
      withdrawalAddress: withdrawer1,
      addedAmount: depositAmount.sub(validatorDepositAmount),
      totalAmount: depositAmount.sub(validatorDepositAmount)
    });

    // Check contract balance
    await checkCollectorBalance(pools, depositAmount);
  });

  it('adds deposits for different users', async () => {
    let tx;

    // User 1 creates a deposit
    let depositAmount1 = getDepositAmount({
      max: validatorDepositAmount.div(new BN(2))
    });
    ({ tx } = await pools.addDeposit(withdrawer1, {
      from: sender1,
      value: depositAmount1
    }));
    await checkDepositAdded({
      transaction: tx,
      depositsContract: deposits,
      collectorAddress: pools.address,
      entityId: new BN(1),
      senderAddress: sender1,
      withdrawalAddress: withdrawer1,
      addedAmount: depositAmount1,
      totalAmount: depositAmount1
    });

    // User 2 creates a deposit
    let depositAmount2 = getDepositAmount({
      max: validatorDepositAmount.div(new BN(2))
    });
    ({ tx } = await pools.addDeposit(withdrawer2, {
      from: sender2,
      value: depositAmount2
    }));
    await checkDepositAdded({
      transaction: tx,
      depositsContract: deposits,
      collectorAddress: pools.address,
      entityId: new BN(1),
      senderAddress: sender2,
      withdrawalAddress: withdrawer2,
      addedAmount: depositAmount2,
      totalAmount: depositAmount2
    });

    // Check contract balance
    await checkCollectorBalance(pools, depositAmount1.add(depositAmount2));
  });

  it('increases deposit amount in pool', async () => {
    let userBalance = new BN(0);
    for (let i = 0; i < 16; i++) {
      // User creates a deposit
      let depositAmount = getDepositAmount({
        max: validatorDepositAmount.div(new BN(16))
      });
      let { tx } = await pools.addDeposit(withdrawer1, {
        from: sender1,
        value: depositAmount
      });
      userBalance.iadd(depositAmount);
      await checkDepositAdded({
        transaction: tx,
        depositsContract: deposits,
        collectorAddress: pools.address,
        entityId: new BN(1),
        senderAddress: sender1,
        withdrawalAddress: withdrawer1,
        addedAmount: depositAmount,
        totalAmount: userBalance
      });

      // Check contract balance updated
      await checkCollectorBalance(pools, userBalance);
    }
  });

  it('splits deposit amount if it goes to different pools', async () => {
    let balance1 = new BN(0);
    let balance2 = new BN(0);

    for (let i = 0; i < 16; i++) {
      // Create a deposit
      let depositAmount = getDepositAmount({
        min: validatorDepositAmount.div(new BN(16)).add(new BN(1)),
        max: validatorDepositAmount.div(new BN(8))
      });
      const { tx } = await pools.addDeposit(withdrawer1, {
        from: sender1,
        value: depositAmount
      });

      if (balance1.add(depositAmount).lte(validatorDepositAmount)) {
        // Deposit goes to pool 1
        balance1.iadd(depositAmount);
        await checkDepositAdded({
          transaction: tx,
          depositsContract: deposits,
          collectorAddress: pools.address,
          entityId: new BN(1),
          senderAddress: sender1,
          withdrawalAddress: withdrawer1,
          addedAmount: depositAmount,
          totalAmount: balance1
        });
      } else if (balance1.eq(validatorDepositAmount)) {
        // Deposit goes to pool 2
        balance2.iadd(depositAmount);
        await checkDepositAdded({
          transaction: tx,
          depositsContract: deposits,
          collectorAddress: pools.address,
          entityId: new BN(2),
          senderAddress: sender1,
          withdrawalAddress: withdrawer1,
          addedAmount: depositAmount,
          totalAmount: balance2
        });
      } else {
        // Deposit was split between pool 1 and 2
        const toPool1 = validatorDepositAmount.sub(balance1);
        balance1.iadd(toPool1);
        await checkDepositAdded({
          transaction: tx,
          depositsContract: deposits,
          collectorAddress: pools.address,
          entityId: new BN(1),
          senderAddress: sender1,
          withdrawalAddress: withdrawer1,
          addedAmount: toPool1,
          totalAmount: balance1
        });

        const toPool2 = depositAmount.sub(toPool1);
        balance2.iadd(toPool2);
        await checkDepositAdded({
          transaction: tx,
          depositsContract: deposits,
          collectorAddress: pools.address,
          entityId: new BN(2),
          senderAddress: sender1,
          withdrawalAddress: withdrawer1,
          addedAmount: toPool2,
          totalAmount: balance2
        });
      }

      // Check contract balance
      await checkCollectorBalance(pools, balance1.add(balance2));
    }
  });
});