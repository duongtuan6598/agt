// The Rust rules against the JavaScript ones (tests/vectors.json, made by make-vectors.js).
use agt_chain::{address, canon, sig};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json")).unwrap()).unwrap()
}

#[test]
fn canon_and_hash_match_javascript() {
    for v in vectors()["canon"].as_array().unwrap() {
        let val: Value = serde_json::from_str(v["json"].as_str().unwrap()).unwrap();
        assert_eq!(canon::canon(&val), v["canon"].as_str().unwrap());
        assert_eq!(canon::hex0x(&canon::hash_of(&val)), v["hash"].as_str().unwrap());
    }
}

#[test]
fn addresses_match_javascript() {
    for a in vectors()["addrs"].as_array().unwrap() {
        let (hex, agt) = (a["hex"].as_str().unwrap(), a["agt"].as_str().unwrap());
        assert_eq!(address::to_agt(hex).unwrap(), agt);
        assert_eq!(address::from_agt(agt).unwrap(), hex);
        assert_eq!(address::to_hex(&agt.to_uppercase()).unwrap(), hex);
        let mut typo = agt.to_string();
        typo.replace_range(10..11, if &agt[10..11] == "q" { "p" } else { "q" });
        assert!(address::from_agt(&typo).is_err(), "a typo is caught");
    }
}

#[test]
fn signatures_match_javascript() {
    for s in vectors()["sigs"].as_array().unwrap() {
        let d: [u8; 32] = hex::decode(&s["digest"].as_str().unwrap()[2..]).unwrap().try_into().unwrap();
        let (sg, who, old) = (s["sig"].as_str().unwrap(), s["who"].as_str().unwrap(), s["old"].as_bool().unwrap());
        assert_eq!(sig::recover(&d, sg, true).unwrap(), who);
        assert_eq!(sig::recover(&d, sg, false).is_ok(), !old, "the old form only before rules v4");
    }
}
