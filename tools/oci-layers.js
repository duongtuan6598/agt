// Print each layer of an OCI image tar: compressed digest and uncompressed digest (diff_id).
// Two builds whose diff_ids match but whose compressed digests differ differ only in compression, not in content.
//   node tools/oci-layers.js image.tar
const { execFileSync } = require("child_process");
const tarFile = process.argv[2];
const local = /^[A-Za-z]:/.test(tarFile) ? ["--force-local"] : [];
const read = (name) => execFileSync("tar", [...local, "-xOf", tarFile, name], { maxBuffer: 1 << 26 }).toString();
const blob = (d) => JSON.parse(read(`blobs/sha256/${d.slice(7)}`));
const manifest = blob(JSON.parse(read("index.json")).manifests[0].digest);
const config = blob(manifest.config.digest);
console.log(`config ${manifest.config.digest}`);
manifest.layers.forEach((l, i) => console.log(`layer ${String(i).padStart(2)} gz ${l.digest.slice(7, 19)} raw ${config.rootfs.diff_ids[i].slice(7, 19)} ${config.history ? "" : ""}`));
