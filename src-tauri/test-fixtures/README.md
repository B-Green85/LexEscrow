# Test fixtures

`docusign_test_key.pem` is a throwaway RSA-2048 keypair generated solely so the
`docusign::build_jwt` unit tests have a parseable PKCS#1 PEM to sign with. It is
**not** a credential: it is not registered with DocuSign, grants no access to any
account, and is committed deliberately so `cargo test` runs offline with no
setup.

Real DocuSign private keys live only in the AES-256-GCM credential vault
(`vault.rs`), are entered through the Configuration screen, and never touch the
repository.
