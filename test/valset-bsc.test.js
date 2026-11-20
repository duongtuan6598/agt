const { expect } = require("chai");
const { ethers } = require("hardhat");
const { makeBscView } = require("../chain/abci/app.js");

const ATT = ethers.id("sealed-box");
describe("AGT chain reads its validator set from AGTWork licences on BSC", () => {
  it("snapshot at a given BSC block: only active, sealed-box licences; history stays readable", async () => {
    const s = await ethers.getSigners();
    const [founder, A, B, Cc] = s;
    const work = await (await ethers.getContractFactory("AGTWork")).deploy(founder.address, 3);
    const view = makeBscView({ BSC_PROVIDER: ethers.provider, WORK: await work.getAddress(), CONFIRMATIONS: "0" });

    await work.grantLicense(A.address, s[10].address, 2, ethers.id("a"), ATT, "A");
    await work.grantLicense(B.address, s[11].address, 1, ethers.id("b"), ethers.ZeroHash, "B, no sealed box");
    const b1 = await view.head();
    const v1 = await view.valsetAt(b1);
    expect(v1.holders).to.equal(2);
    expect(v1.validators.map((v) => v.agent)).to.deep.equal([s[10].address]);

    await work.grantLicense(Cc.address, s[12].address, 2, ethers.id("c"), ATT, "C");
    await work.revokeLicense(1);
    const v2 = await view.valsetAt(await view.head());
    expect(v2.validators.map((v) => [v.id, v.agent])).to.deep.equal([[3, s[12].address]]);
    expect(v2.holders).to.equal(2);

    // A validator re-checking an older proposal reads BSC at THAT block, not at its own head.
    const again = makeBscView({ BSC_PROVIDER: ethers.provider, WORK: await work.getAddress(), CONFIRMATIONS: "0" });
    expect(await again.valsetAt(b1)).to.deep.equal(v1);
  });
});
