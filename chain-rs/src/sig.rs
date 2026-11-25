//! AGT's own signature form, exactly as chain/sig.js: a 65-byte r‖s‖v signature over
//! keccak256("\x19AGT Signed Message:\n32" ‖ digest), written "agt:0x…". Before rules v4 the older Ethereum message
//! form (keccak256("\x19Ethereum Signed Message:\n32" ‖ digest)) is also accepted.
use crate::canon::keccak;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

const PREFIX: &[u8] = b"\x19AGT Signed Message:\n32";
const ETH_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n32";

fn prefixed(prefix: &[u8], digest: &[u8; 32]) -> [u8; 32] {
    let mut b = prefix.to_vec();
    b.extend_from_slice(digest);
    keccak(&b)
}

/// the signer's address (lowercase 0x hex) of a 65-byte signature over a 32-byte message hash
fn recover_hash(hash: &[u8; 32], sig_hex: &str) -> Result<String, String> {
    let s = sig_hex.strip_prefix("0x").ok_or("signature must be 0x hex")?;
    let raw = hex::decode(s).map_err(|_| "signature is not hex")?;
    if raw.len() != 65 {
        return Err("signature must be 65 bytes".into());
    }
    let v = raw[64];
    let rec = match v {
        27 | 28 => v - 27,
        0 | 1 => v,
        _ => return Err("bad signature v".into()),
    };
    let sig = Signature::from_slice(&raw[..64]).map_err(|e| e.to_string())?;
    // ethers accepts only low-s signatures
    if sig.normalize_s().is_some() {
        return Err("non-canonical s".into());
    }
    let key = VerifyingKey::recover_from_prehash(hash, &sig, RecoveryId::try_from(rec).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let pt = key.to_encoded_point(false);
    let h = keccak(&pt.as_bytes()[1..]);
    Ok(format!("0x{}", hex::encode(&h[12..])))
}

pub fn recover(digest: &[u8; 32], sig: &str, allow_old: bool) -> Result<String, String> {
    if let Some(rest) = sig.strip_prefix("agt:") {
        return recover_hash(&prefixed(PREFIX, digest), rest);
    }
    if !allow_old {
        return Err("signature must be AGT's own form (agt:…) from rules v4".into());
    }
    recover_hash(&prefixed(ETH_PREFIX, digest), sig)
}
