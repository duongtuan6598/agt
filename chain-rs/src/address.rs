//! AGT's own address form, exactly as chain/address.js: "agt1" + bech32m (BIP-350) of the 20-byte account.
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const M: u32 = 0x2bc830a3;
const HRP: &str = "agt";

fn polymod(v: &[u8]) -> u32 {
    let mut c: u32 = 1;
    for &x in v {
        let b = c >> 25;
        c = ((c & 0x1ffffff) << 5) ^ x as u32;
        for (i, g) in GEN.iter().enumerate() {
            if (b >> i) & 1 == 1 {
                c ^= g;
            }
        }
    }
    c
}
fn hrpx() -> Vec<u8> {
    let mut v: Vec<u8> = HRP.bytes().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(HRP.bytes().map(|c| c & 31));
    v
}
fn convert(data: &[u8], from: u32, to: u32, pad: bool) -> Result<Vec<u8>, String> {
    let (mut acc, mut bits) = (0u32, 0u32);
    let maxv = (1u32 << to) - 1;
    let mut out = vec![];
    for &v in data {
        acc = (acc << from) | v as u32;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return Err("bad AGT address padding".into());
    }
    Ok(out)
}
fn hex_bytes(h: &str) -> Result<Vec<u8>, String> {
    let s = h.strip_prefix("0x").or_else(|| h.strip_prefix("0X")).unwrap_or(h);
    if s.len() != 40 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("not a 20-byte account".into());
    }
    hex::decode(s).map_err(|e| e.to_string())
}

pub fn to_agt(hex: &str) -> Result<String, String> {
    let words = convert(&hex_bytes(hex)?, 8, 5, true)?;
    let mut v = hrpx();
    v.extend(&words);
    v.extend([0u8; 6]);
    let m = polymod(&v) ^ M;
    let mut s = String::from("agt1");
    for w in words.iter().chain((0..6).map(|i| ((m >> (5 * (5 - i))) & 31) as u8).collect::<Vec<_>>().iter()) {
        s.push(CHARSET[*w as usize] as char);
    }
    Ok(s)
}

pub fn from_agt(addr: &str) -> Result<String, String> {
    if addr != addr.to_lowercase() && addr != addr.to_uppercase() {
        return Err("mixed case AGT address".into());
    }
    let s = addr.to_lowercase();
    let rest = s.strip_prefix("agt1").ok_or("not an AGT address (agt1…)")?;
    let mut data = vec![];
    for ch in rest.bytes() {
        data.push(CHARSET.iter().position(|&c| c == ch).ok_or("bad character in AGT address")? as u8);
    }
    let mut v = hrpx();
    v.extend(&data);
    if data.len() < 6 || polymod(&v) != M {
        return Err("AGT address checksum is wrong (a typo?)".into());
    }
    let bytes = convert(&data[..data.len() - 6], 5, 8, false)?;
    if bytes.len() != 20 {
        return Err("AGT address has the wrong length".into());
    }
    Ok(format!("0x{}", hex::encode(bytes)))
}

pub fn is_agt(a: &str) -> bool {
    a.len() >= 4 && a[..4].eq_ignore_ascii_case("agt1")
}

/// any form → the ledger's internal form (lowercase hex)
pub fn to_hex(a: &str) -> Result<String, String> {
    if is_agt(a) {
        from_agt(a)
    } else {
        Ok(format!("0x{}", hex::encode(hex_bytes(a)?)))
    }
}
