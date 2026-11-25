//! AGT's chain agt-2 in Rust. The same rules as chain/abci/app.js, checked byte for byte: every module is compared
//! with the JavaScript one on shared test vectors (tests/vectors.json, made by chain-rs/make-vectors.js), and the
//! whole chain is replayed from genesis until the app hash matches at every height.
pub mod address;
pub mod canon;
pub mod sig;
