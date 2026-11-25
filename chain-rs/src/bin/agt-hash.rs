// The app hash of a state file (app.js STATE_FILE format): cargo run --bin agt-hash -- app-state.json
fn main() {
    let path = std::env::args().nth(1).expect("state file");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let s = v.get("state").unwrap_or(&v);
    println!("height {} app hash {}", s["height"], agt_chain::canon::hex0x(&agt_chain::canon::hash_of(s)));
}
