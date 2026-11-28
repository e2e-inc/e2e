# Vendored license texts

Some crates the addon links publish no license file of their own: their
license sits at the root of the repository they come from. `scripts/native/native-licenses.ts`
takes their notices from here, by the crate's repository, so the platform
packages ship the copyright and permission notice the license requires.

- `napi-rs/napi-rs/LICENSE`: from github.com/napi-rs/napi-rs at the revisions
  `napi` 3.16.3 and `napi-sys` 3.4.1 record (identical at both), the same
  text as `crates/e2e-desktop-napi/licenses`.

A crate with no license file and no texts here fails the generator, never a
placeholder: add its repository's texts here after reading its license.
