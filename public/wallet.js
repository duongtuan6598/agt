// AGT's own wallet, in the page: no MetaMask, no other chain's wallet. The key is made here, in your browser, and kept
// here encrypted with your passphrase (scrypt keystore). Nobody else holds it, so nobody can recover it for you:
// export the backup and keep it safe. Addresses are written AGT's way: agt1… (chain/address.js).
//   const w = await AGTWallet.open();        // asks: create, unlock or import; returns a signer for agt1.js
//   w.address  → "agt1…"     w.hex → "0x…" (the ledger's internal form)
(function () {
  const STORE = "agt-wallet-v1";
  const read = () => { try { return localStorage.getItem(STORE); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(STORE, v); return true; } catch { return false; } };
  let unlocked = null;

  function signerOf(w) {
    return {
      address: AGTAddress.toAgt(w.address),
      hex: w.address.toLowerCase(),
      getAddress: async () => w.address,
      signMessage: async (m) => w.signMessage(m),
    };
  }
  async function create(pass) {
    const w = ethers.Wallet.createRandom();
    if (!write(await w.encrypt(pass))) throw new Error("this browser cannot store the wallet (private window?): export the backup now");
    return (unlocked = signerOf(w));
  }
  async function unlock(pass) {
    const k = read();
    if (!k) throw new Error("no AGT wallet in this browser yet");
    return (unlocked = signerOf(await ethers.Wallet.fromEncryptedJson(k, pass)));
  }
  async function importBackup(json, pass) {
    const w = await ethers.Wallet.fromEncryptedJson(json, pass); // checks the passphrase before keeping it
    write(json);
    return (unlocked = signerOf(w));
  }
  function exportBackup() {
    const k = read();
    if (!k) throw new Error("no AGT wallet in this browser");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([k], { type: "application/json" }));
    a.download = "agt-wallet-backup.json";
    a.click();
  }
  // the simplest dialog: prompts; pages may build their own UI on create/unlock/importBackup
  async function open() {
    if (unlocked) return unlocked;
    if (read()) {
      const pass = prompt("Passphrase of your AGT wallet:");
      if (!pass) throw new Error("wallet stays locked");
      return unlock(pass);
    }
    if (confirm("No AGT wallet in this browser. OK = create a new one here. Cancel = import a backup file.")) {
      const pass = prompt("Choose a passphrase (at least 10 characters). It encrypts the key in this browser; nobody can recover it for you.");
      if (!pass || pass.length < 10) throw new Error("passphrase too short");
      const s = await create(pass);
      if (confirm(`Your AGT address: ${s.address}\n\nDownload the encrypted backup now? (Recommended: without it, clearing this browser loses the wallet.)`)) exportBackup();
      return s;
    }
    const file = await new Promise((ok) => { const i = document.createElement("input"); i.type = "file"; i.accept = ".json"; i.onchange = () => ok(i.files[0]); i.click(); });
    if (!file) throw new Error("no backup chosen");
    const pass = prompt("Passphrase of this backup:");
    return importBackup(await file.text(), pass || "");
  }
  window.AGTWallet = { open, create, unlock, importBackup, exportBackup, has: () => !!read(), lock: () => { unlocked = null; } };
})();
