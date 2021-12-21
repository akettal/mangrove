const hre = require("hardhat");
const helper = require("../helper");
const { logOrderBook } = require("../../lib/libcommon");
const chalk = require("chalk");
const { NonceManager } = require("@ethersproject/experimental");

async function main() {
  if (!process.env["MUMBAI_DEPLOYER_PRIVATE_KEY"]) {
    console.error("No Deployer account defined");
  }
  const wallet = new ethers.Wallet(
    process.env["MUMBAI_DEPLOYER_PRIVATE_KEY"],
    helper.getProvider()
  );
  const nonceManager = new NonceManager(wallet);
  const repostLogic = (await hre.ethers.getContract("Reposting")).connect(
    wallet
  );
  const OldRepostingFactory = await hre.ethers.getContractFactory("Reposting");
  const oldRepostLogic = (
    await OldRepostingFactory.attach(
      "0xA4B155b7e5b9D73548971c5842D5835fE9C006fb"
    )
  ).connect(wallet);

  // const admin = await repostLogic.admin();
  // const admin_ = await oldRepostLogic.admin();

  const mgvContracts = await helper.getMangrove();
  console.log(
    "Running script on Mangrove",
    chalk.gray(`(${mgvContracts.contract.address})`)
  );
  const mgv = mgvContracts.contract.connect(nonceManager);

  const weth = helper.contractOfToken("wEth");
  const dai = helper.contractOfToken("dai");
  const usdc = helper.contractOfToken("usdc");

  const tokenParams = [
    [weth, "wEth", 18, ethers.utils.parseEther("1")],
    [dai, "dai", 18, ethers.utils.parseEther("0.0002")],
    [usdc, "usdc", 6, ethers.utils.parseEther("0.0002")],
  ];

  for (const [outbound_tkn, outName] of tokenParams) {
    for (const [inbound_tkn, inName] of tokenParams) {
      if (outbound_tkn.address != inbound_tkn.address) {
        console.log(
          `* Looking for Deployer offers in the (${outName},${inName}) OfferList...`
        );
        const [id, offerIds, offers, offerDetails] =
          await mgvContracts.reader.offerList(
            outbound_tkn.address,
            inbound_tkn.address,
            ethers.BigNumber.from(0),
            ethers.BigNumber.from(1000)
          );
        await logOrderBook(
          [id, offerIds, offers, offerDetails],
          outbound_tkn,
          inbound_tkn
        );
        const retractTxPromises = [];
        for (const i in offerDetails) {
          if (
            [repostLogic.address, oldRepostLogic.address].includes(
              offerDetails[i].maker
            )
          ) {
            let contract = oldRepostLogic;
            if (offerDetails[i].maker == repostLogic.address) {
              contract = repostLogic;
            }
            const provision = await contract.callStatic.retractOffer(
              outbound_tkn.address,
              inbound_tkn.address,
              offerIds[i],
              true
            );
            const txPromise = contract
              .retractOffer(
                outbound_tkn.address,
                inbound_tkn.address,
                offerIds[i],
                true
              )
              .then((tx) => tx.wait())
              .then((txReceipt) => {
                console.log(
                  `* Offer`,
                  chalk.gray(offerIds[i].toString()),
                  `retracted, ${ethers.utils.formatUnits(
                    provision,
                    18
                  )} was credited to Deployer provisions (${
                    txReceipt.gasUsed
                  } gas used)`
                );
              });
            retractTxPromises.push(txPromise);
          }
        }
        await Promise.allSettled(retractTxPromises);
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });