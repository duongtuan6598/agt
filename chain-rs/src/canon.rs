//! Canonical JSON and hashing, exactly as chain/core.js `canon` / `hashOf`:
//! keys sorted (by UTF-16 code units, like JavaScript's `sort()`), bigints written as decimal strings,
//! numbers written the way JavaScript writes them, strings escaped the way `JSON.stringify` escapes them.
//! A bigint in the state is held as `{"$n": "<decimal>"}` (the state file format of app.js `ser`).
use serde_json::Value;
use sha3::{Digest, Keccak256};

pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(bytes);
    h.finalize().into()
}

pub fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// `{"$n": "..."}` → Some("...") (a bigint of the JavaScript state)
pub fn as_bigint(v: &Value) -> Option<&str> {
    match v {
        Value::Object(m) if m.len() == 1 => m.get("$n").and_then(|x| x.as_str()),
        _ => None,
    }
}

/// JavaScript's `JSON.stringify` of a string
pub fn js_string(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serialises")
}

/// JavaScript's `String(number)` (and `JSON.stringify(number)`; non-finite numbers become null there)
pub fn js_number(n: &serde_json::Number) -> String {
    let f: f64 = n.to_string().parse().unwrap_or(f64::NAN);
    if !f.is_finite() {
        return "null".into();
    }
    if f == 0.0 {
        return "0".into(); // -0 is written 0
    }
    let mut buf = ryu_js::Buffer::new();
    buf.format_finite(f).to_string()
}

fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn canon(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Value, out: &mut String) {
    if let Some(n) = as_bigint(v) {
        out.push_str(&js_string(n));
        return;
    }
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => out.push_str(&js_string(s)),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&js_string(k));
                out.push(':');
                write(&m[k.as_str()], out);
            }
            out.push('}');
        }
    }
}

/// chain/core.js `hashOf`
pub fn hash_of(v: &Value) -> [u8; 32] {
    keccak(canon(v).as_bytes())
}
