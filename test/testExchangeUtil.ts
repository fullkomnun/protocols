import { BigNumber } from "bignumber.js";
import BN = require("bn.js");
import childProcess = require("child_process");
import ethUtil = require("ethereumjs-util");
import fs = require("fs");
import * as pjs from "protocol2-js";
import util = require("util");
import { Artifacts } from "../util/Artifacts";
import { Context } from "./context";
import { ExchangeTestContext } from "./testExchangeContext";
import { OrderInfo, OrderSettlementData, RingInfo, RingSettlementData, RingsInfo } from "./types";

export class ExchangeTestUtil {
  public context: Context;
  public testContext: ExchangeTestContext;
  public exchange: any;

  private contracts = new Artifacts(artifacts);

  private tokenIDMap = new Map<string, number>();

  public async initialize(accounts: string[]) {
    this.context = await this.createContractContext();
    this.testContext = await this.createExchangeTestContext(accounts);
    await this.authorizeTradeDelegate();
    await this.approveTradeDelegate();
    await this.cleanTradeHistory();
  }

  public assertNumberEqualsWithPrecision(n1: number, n2: number, precision: number = 8) {
    const numStr1 = (n1 / 1e18).toFixed(precision);
    const numStr2 = (n2 / 1e18).toFixed(precision);

    return assert.equal(Number(numStr1), Number(numStr2));
  }

  public async getEventsFromContract(contract: any, eventName: string, fromBlock: number) {
    return await contract.getPastEvents(eventName, {
      fromBlock,
      toBlock: "latest",
    }).then((events: any) => {
        return events;
    });
  }

  public async getTransferEvents(tokens: any[], fromBlock: number) {
    let transferItems: Array<[string, string, string, BN]> = [];
    for (const tokenContractInstance of tokens) {
      const eventArr: any = await this.getEventsFromContract(tokenContractInstance, "Transfer", fromBlock);
      const items = eventArr.map((eventObj: any) => {
        return [tokenContractInstance.address, eventObj.args.from, eventObj.args.to, eventObj.args.value];
      });
      transferItems = transferItems.concat(items);
    }

    return transferItems;
  }

  public async watchAndPrintEvent(contract: any, eventName: string) {
    const events: any = await this.getEventsFromContract(contract, eventName, web3.eth.blockNumber);

    events.forEach((e: any) => {
      pjs.logDebug("event:", util.inspect(e.args, false, null));
    });
  }

  public async setupRings(ringsInfo: RingsInfo) {
    for (const [i, ring] of ringsInfo.rings.entries()) {
      await this.setupOrder(ring.orderA, i);
      await this.setupOrder(ring.orderB, i);
    }
  }

  public async setupOrder(order: OrderInfo, index: number) {
    if (order.owner === undefined) {
      const accountIndex = index % this.testContext.orderOwners.length;
      order.owner = this.testContext.orderOwners[accountIndex];
    } else if (order.owner !== undefined && !order.owner.startsWith("0x")) {
      const accountIndex = parseInt(order.owner, 10);
      assert(accountIndex >= 0 && accountIndex < this.testContext.orderOwners.length, "Invalid owner index");
      order.owner = this.testContext.orderOwners[accountIndex];
    }
    if (!order.tokenS.startsWith("0x")) {
      order.tokenS = this.testContext.tokenSymbolAddrMap.get(order.tokenS);
    }
    if (!order.tokenB.startsWith("0x")) {
      order.tokenB = this.testContext.tokenSymbolAddrMap.get(order.tokenB);
    }
    if (order.tokenF && !order.tokenF.startsWith("0x")) {
      order.tokenF = this.testContext.tokenSymbolAddrMap.get(order.tokenF);
    }
    if (!order.validSince) {
      // Set the order validSince time to a bit before the current timestamp;
      const blockNumber = await web3.eth.getBlockNumber();
      order.validSince = (await web3.eth.getBlock(blockNumber)).timestamp - 1000;
    }
    if (!order.validUntil && (order.index % 2) === 1) {
      // Set the order validUntil time to a bit after the current timestamp;
      const blockNumber = await web3.eth.getBlockNumber();
      order.validUntil = (await web3.eth.getBlock(blockNumber)).timestamp + 2500;
    }

    // Fill in defaults (default, so these will not get serialized)
    order.version = 0;
    order.validUntil = order.validUntil ? order.validUntil : 0;
    order.tokenF = order.tokenF ? order.tokenF : this.context.lrcAddress;
    order.amountF = order.amountF ? order.amountF : 0;

    order.dexID = order.dexID ? order.dexID : 0;
    order.orderID = order.orderID ? order.orderID : order.index;

    if (order.index === 0) {
      order.accountS = 0;
      order.accountB = 1;
      order.accountF = 2;
      order.tokenIdS = 1;
      order.tokenIdB = 2;
      order.tokenIdF = 3;
    } else {
      order.accountS = 4;
      order.accountB = 3;
      order.accountF = 5;
      order.tokenIdS = 2;
      order.tokenIdB = 1;
      order.tokenIdF = 3;
    }

    // setup initial balances:
    await this.setOrderBalances(order);
  }

  public async setOrderBalances(order: pjs.OrderInfo) {
    const tokenS = this.testContext.tokenAddrInstanceMap.get(order.tokenS);
    const balanceS = (order.balanceS !== undefined) ? order.balanceS : order.amountS;
    await tokenS.setBalance(order.owner, web3.utils.toBN(new BigNumber(balanceS)));

    const balanceF = (order.balanceF !== undefined) ? order.balanceF : order.amountF;
    if (order.tokenF === order.tokenS) {
      tokenS.addBalance(order.owner, web3.utils.toBN(new BigNumber(balanceF)));
    } else {
      const tokenF = this.testContext.tokenAddrInstanceMap.get(order.tokenF);
      await tokenF.setBalance(order.owner, web3.utils.toBN(new BigNumber(balanceF)));
    }

    if (order.balanceB) {
      const tokenB = this.testContext.tokenAddrInstanceMap.get(order.tokenB);
      await tokenB.setBalance(order.owner, web3.utils.toBN(new BigNumber(order.balanceB)));
    }
  }

  public getAddressBook(ringsInfo: RingsInfo) {
    const addAddress = (addrBook: { [id: string]: any; }, address: string, name: string) => {
      addrBook[address] = (addrBook[address] ? addrBook[address] + "=" : "") + name;
    };

    const addressBook: { [id: string]: string; } = {};
    for (const ring of ringsInfo.rings) {
      const orders = [ring.orderA, ring.orderB];
      for (const [i, order] of orders.entries()) {
        addAddress(addressBook, order.owner, "Owner[" + i + "]");
        if (order.owner !== order.tokenRecipient) {
          addAddress(addressBook, order.tokenRecipient, "TokenRecipient[" + i + "]");
        }
        addAddress(addressBook, order.walletAddr, "Wallet[" + i + "]");
        // addAddress(addressBook, order.hash.toString("hex"), "Hash[" + i + "]");
      }
    }
    return addressBook;
  }

  public flattenList = (l: any[]) => {
    return [].concat.apply([], l);
  }

  public flattenVK = (vk: any) => {
    return [
      this.flattenList([
        vk.alpha[0], vk.alpha[1],
        this.flattenList(vk.beta),
        this.flattenList(vk.gamma),
        this.flattenList(vk.delta),
      ]),
      this.flattenList(vk.gammaABC),
    ];
  }

  public flattenProof = (proof: any) => {
    return this.flattenList([
        proof.A,
        this.flattenList(proof.B),
        proof.C,
    ]);
  }

  public async settleRing(ring: RingInfo) {
    const orderA = ring.orderA;
    const orderB = ring.orderB;

    ring.fillS_A = orderA.amountS / 100;
    ring.fillB_A = orderA.amountB / 100;
    ring.fillF_A = orderA.amountF / 100;
    ring.fillS_B = orderB.amountS / 100;
    ring.fillB_B = orderB.amountB / 100;
    ring.fillF_B = orderB.amountF / 100;

    const orderDataA: OrderSettlementData = {
      dexID: orderA.dexID,
      orderID: orderA.orderID,

      fromS: orderA.accountS,
      toB: orderB.accountB,
      amountS: ring.fillS_A,
      toMargin: 0,
      marginPercentage: 0,

      fromF: orderA.accountF,
      toWallet: 0,
      toOperator: 0,
      amountF: ring.fillF_A,
      WalletSplitPercentage: 0,
    };

    const orderDataB: OrderSettlementData = {
      dexID: orderB.dexID,
      orderID: orderB.orderID,

      fromS: orderB.accountS,
      toB: orderA.accountB,
      amountS: ring.fillS_B,
      toMargin: 0,
      marginPercentage: 0,

      fromF: orderB.accountF,
      toWallet: 0,
      toOperator: 0,
      amountF: ring.fillF_B,
      WalletSplitPercentage: 0,
    };

    const ringSettlement: RingSettlementData = {
      orderA: orderDataA,
      orderB: orderDataB,
    };

    return ringSettlement;
  }

  public async settleRings(ringsInfo: RingsInfo) {
    const ringSettlements: RingSettlementData[] = [];
    for (const ring of ringsInfo.rings) {
      ringSettlements.push(await this.settleRing(ring));
    }
    return ringSettlements;
  }

  public async submitRings(ringsInfo: RingsInfo) {
    // Generate the token transfers for the ring
    const ringSettlements = await this.settleRings(ringsInfo);

    // Write out the rings info
    const jRingsInfo = JSON.stringify(ringsInfo, null, 4);
    fs.writeFileSync("rings_info.json", jRingsInfo, "utf8");

    // Generate the proof
    childProcess.spawnSync("python3", ["generate_proof.py"], {stdio: "inherit"});

    // Read the proof
    const jProof = fs.readFileSync("proof.json", "ascii");
    const proof = JSON.parse(jProof);
    const proofFlattened = this.flattenProof(proof);
    // console.log(proof);
    // console.log(this.flattenProof(proof));

    const jRings = fs.readFileSync("rings.json", "ascii");
    const rings = JSON.parse(jRings);

    const bs = new pjs.Bitstream();
    // console.log(rings.rootBefore);
    bs.addBigNumber(new BigNumber(rings.tradingHistoryMerkleRootBefore, 10), 32);
    bs.addBigNumber(new BigNumber(rings.tradingHistoryMerkleRootAfter, 10), 32);
    console.log(ringSettlements);
    for (const ringSettlement of ringSettlements) {
      const orders = [ringSettlement.orderA, ringSettlement.orderB];
      for (const order of orders) {
        bs.addNumber(order.dexID, 2);
        bs.addNumber(order.orderID, 2);

        bs.addNumber(order.fromS, 3);
        bs.addNumber(order.toB, 3);
        // bs.addNumber(order.toMargin, 3);
        bs.addNumber(order.amountS, 12);
        // bs.addNumber(order.marginPercentage, 1);

        bs.addNumber(order.fromF, 3);
        // bs.addNumber(order.toWallet, 3);
        // bs.addNumber(order.toOperator, 3);
        bs.addNumber(order.amountF, 12);
        // bs.addNumber(order.WalletSplitPercentage, 1);
      }
    }

    // Hash all public inputs to a singe value
    const publicDataHash = ethUtil.sha256(bs.getData());
    console.log("DataJS: " + bs.getData());
    console.log(publicDataHash.toString("hex"));
    ringsInfo.publicDataHash = publicDataHash.toString("hex");

    // Read the verification key and set it in the smart contract
    const jVK = fs.readFileSync("vk.json", "ascii");
    const vk = JSON.parse(jVK);
    const vkFlattened = this.flattenVK(vk);
    await this.exchange.setVerifyingKey(vkFlattened[0], vkFlattened[1]);

    // Submit the rings
    const tx = await this.exchange.submitRings(web3.utils.hexToBytes(bs.getData()), proofFlattened);
    pjs.logInfo("\x1b[46m%s\x1b[0m", "Gas used: " + tx.receipt.gasUsed);

    // const transferEvents = await this.getTransferEvents(this.testContext.allTokens, web3.eth.blockNumber);
    // this.assertTransfers(ringsInfo, transferEvents, transfers);

    // await this.watchAndPrintEvent(this.exchange, "TestLog");

    return tx;
  }

  public async registerTokens() {
    for (const token of this.testContext.allTokens) {
      await this.exchange.registerToken(token.address);
      this.tokenIDMap.set(token.address, await this.getTokenID(token.address));
    }
  }

  public async getTokenID(tokenAddress: string) {
    const tokenID = await this.exchange.getTokenID(tokenAddress);
    return tokenID;
  }

  public async authorizeTradeDelegate() {
    const alreadyAuthorized = await this.context.tradeDelegate.methods.isAddressAuthorized(
      this.exchange.address,
    ).call();
    if (!alreadyAuthorized) {
      await this.context.tradeDelegate.methods.authorizeAddress(
        this.exchange.address,
      ).send({from: this.testContext.deployer});
    }
  }

  public async approveTradeDelegate() {
    for (const token of this.testContext.allTokens) {
      // approve once for all orders:
      for (const orderOwner of this.testContext.orderOwners) {
        await token.approve(this.context.tradeDelegate.options.address,
                            web3.utils.toBN(new BigNumber(1e31)),
                            {from: orderOwner});
      }
    }
  }

  public async cleanTradeHistory() {
    if (fs.existsSync("dex.json")) {
      fs.unlinkSync("dex.json");
    }
  }

  private getPrivateKey(address: string) {
    const textData = fs.readFileSync("./ganache_account_keys.txt", "ascii");
    const data = JSON.parse(textData);
    return data.private_keys[address.toLowerCase()];
  }

  // private functions:
  private async createContractContext() {
    const [exchange, tradeDelegate, lrcToken] = await Promise.all([
        this.contracts.Exchange.deployed(),
        this.contracts.TradeDelegate.deployed(),
        this.contracts.LRCToken.deployed(),
      ]);

    this.exchange = exchange;

    const currBlockNumber = await web3.eth.getBlockNumber();
    const currBlockTimestamp = (await web3.eth.getBlock(currBlockNumber)).timestamp;
    return new Context(currBlockNumber,
                       currBlockTimestamp,
                       this.contracts.TradeDelegate.address,
                       this.contracts.LRCToken.address);
  }

  private async createExchangeTestContext(accounts: string[]) {
    const tokenSymbolAddrMap = new Map<string, string>();
    const tokenAddrSymbolMap = new Map<string, string>();
    const tokenAddrDecimalsMap = new Map<string, number>();
    const tokenAddrInstanceMap = new Map<string, any>();

    const [lrc, gto, rdn, rep, weth, inda, indb, test] = await Promise.all([
      this.contracts.LRCToken.deployed(),
      this.contracts.GTOToken.deployed(),
      this.contracts.RDNToken.deployed(),
      this.contracts.REPToken.deployed(),
      this.contracts.WETHToken.deployed(),
      this.contracts.INDAToken.deployed(),
      this.contracts.INDBToken.deployed(),
      this.contracts.TESTToken.deployed(),
    ]);

    const allTokens = [lrc, gto, rdn, rep, weth, inda, indb, test];

    tokenSymbolAddrMap.set("LRC", this.contracts.LRCToken.address);
    tokenSymbolAddrMap.set("GTO", this.contracts.GTOToken.address);
    tokenSymbolAddrMap.set("RDN", this.contracts.RDNToken.address);
    tokenSymbolAddrMap.set("REP", this.contracts.REPToken.address);
    tokenSymbolAddrMap.set("WETH", this.contracts.WETHToken.address);
    tokenSymbolAddrMap.set("INDA", this.contracts.INDAToken.address);
    tokenSymbolAddrMap.set("INDB", this.contracts.INDBToken.address);
    tokenSymbolAddrMap.set("TEST", this.contracts.TESTToken.address);

    for (const token of allTokens) {
      tokenAddrDecimalsMap.set(token.address, (await token.decimals()));
    }

    tokenAddrSymbolMap.set(this.contracts.LRCToken.address, "LRC");
    tokenAddrSymbolMap.set(this.contracts.GTOToken.address, "GTO");
    tokenAddrSymbolMap.set(this.contracts.RDNToken.address, "RDN");
    tokenAddrSymbolMap.set(this.contracts.REPToken.address, "REP");
    tokenAddrSymbolMap.set(this.contracts.WETHToken.address, "WETH");
    tokenAddrSymbolMap.set(this.contracts.INDAToken.address, "INDA");
    tokenAddrSymbolMap.set(this.contracts.INDBToken.address, "INDB");
    tokenAddrSymbolMap.set(this.contracts.TESTToken.address, "TEST");

    tokenAddrInstanceMap.set(this.contracts.LRCToken.address, lrc);
    tokenAddrInstanceMap.set(this.contracts.GTOToken.address, gto);
    tokenAddrInstanceMap.set(this.contracts.RDNToken.address, rdn);
    tokenAddrInstanceMap.set(this.contracts.REPToken.address, rep);
    tokenAddrInstanceMap.set(this.contracts.WETHToken.address, weth);
    tokenAddrInstanceMap.set(this.contracts.INDAToken.address, inda);
    tokenAddrInstanceMap.set(this.contracts.INDBToken.address, indb);
    tokenAddrInstanceMap.set(this.contracts.TESTToken.address, test);

    const deployer = accounts[0];
    const transactionOrigin = accounts[1];
    const feeRecipient = accounts[2];
    const miner = accounts[3];
    const orderOwners = accounts.slice(4, 14);
    const orderDualAuthAddr = accounts.slice(14, 24);
    const allOrderTokenRecipients = accounts.slice(24, 28);
    const wallets = accounts.slice(28, 32);
    const brokers =  accounts.slice(32, 36);

    return new ExchangeTestContext(deployer,
                                   transactionOrigin,
                                   feeRecipient,
                                   miner,
                                   orderOwners,
                                   orderDualAuthAddr,
                                   allOrderTokenRecipients,
                                   wallets,
                                   brokers,
                                   tokenSymbolAddrMap,
                                   tokenAddrSymbolMap,
                                   tokenAddrDecimalsMap,
                                   tokenAddrInstanceMap,
                                   allTokens);
  }

}
