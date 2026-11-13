//! Ed25519 public keys: their SubjectPublicKeyInfo, their key id, PEM, and
//! the signatures of anchors (spec/journal.md "Anchors").

use crate::canonical::sha256_tagged;

/// The DER of an Ed25519 SubjectPublicKeyInfo before the 32 bytes of the key:
/// `SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING (0 unused bits) }`.
pub const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

const BEGIN: &str = "-----BEGIN PUBLIC KEY-----";
const END: &str = "-----END PUBLIC KEY-----";

/// An Ed25519 public key a verifier is given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicKey {
    raw: [u8; 32],
    id: String,
}

impl PublicKey {
    /// The key of these 32 bytes. Any 32 bytes are a key here, as for the
    /// reference: one that is not a point on the curve verifies no signature.
    #[must_use]
    pub fn from_raw(raw: [u8; 32]) -> PublicKey {
        let mut der = Vec::with_capacity(44);
        der.extend_from_slice(&SPKI_PREFIX);
        der.extend_from_slice(&raw);
        PublicKey {
            raw,
            id: sha256_tagged(&[&der]),
        }
    }

    /// The key of an Ed25519 SubjectPublicKeyInfo DER: [`SPKI_PREFIX`] and
    /// the 32 bytes of the key.
    ///
    /// # Errors
    ///
    /// What is wrong, when `der` is not exactly that.
    pub fn from_spki_der(der: &[u8]) -> Result<PublicKey, String> {
        let raw = der
            .strip_prefix(SPKI_PREFIX.as_slice())
            .and_then(|key| <[u8; 32]>::try_from(key).ok())
            .ok_or_else(|| {
                "not the SubjectPublicKeyInfo of an Ed25519 key (the 44 bytes 302a300506032b6570032100 and the key)".to_owned()
            })?;
        Ok(PublicKey::from_raw(raw))
    }

    /// The key id: `sha256:` and the lowercase hex SHA-256 of the key's
    /// SubjectPublicKeyInfo DER.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The 32 bytes of the key.
    #[must_use]
    pub fn raw(&self) -> &[u8; 32] {
        &self.raw
    }

    /// Whether `signature` is this key's Ed25519 signature of `message`
    /// (RFC 8032 §5.1.7, pure Ed25519). `ed25519-compact` checks the
    /// cofactored equation and that S is below L, the order of the base
    /// point, as the spec requires, and also refuses non-canonical encodings
    /// of R and A and points of small order, as it allows.
    #[must_use]
    pub fn verifies(&self, message: &[u8], signature: &[u8; 64]) -> bool {
        ed25519_compact::PublicKey::new(self.raw)
            .verify(message, &ed25519_compact::Signature::new(*signature))
            .is_ok()
    }
}

/// Why a key file gives no keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The text has no `PUBLIC KEY` block.
    NoPublicKey,
    /// A `PUBLIC KEY` block (counted from 1) is not an Ed25519 public key.
    NotEd25519 {
        /// Which block, from 1.
        block: usize,
        /// What is wrong with it.
        why: String,
    },
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::NoPublicKey => write!(f, "holds no public key (PEM, {BEGIN})"),
            KeyError::NotEd25519 { block, why } => {
                write!(f, "is not an Ed25519 public key: block {block}: {why}")
            }
        }
    }
}

/// The Ed25519 public keys in PEM text, in order: every block from
/// `-----BEGIN PUBLIC KEY-----` to `-----END PUBLIC KEY-----` with no `-`
/// between them, as `publicKeysIn` in `runtime/src/journal-chain.ts` finds
/// them. Other text and other blocks (a `PRIVATE KEY`, a `CERTIFICATE`) are
/// not read. A block's base64 is on lines of their own (see `pem_lines`).
///
/// # Errors
///
/// [`KeyError::NoPublicKey`] when there is no such block, and
/// [`KeyError::NotEd25519`] when one is not an Ed25519 SubjectPublicKeyInfo.
pub fn public_keys_in(text: &str) -> Result<Vec<PublicKey>, KeyError> {
    let mut keys = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(BEGIN) {
        let after = rest
            .get(at.saturating_add(BEGIN.len())..)
            .unwrap_or_default();
        let body_len = after.find('-').unwrap_or(after.len());
        let (body, tail) = after.split_at_checked(body_len).unwrap_or((after, ""));
        if let Some(next) = tail.strip_prefix(END) {
            let block = keys.len().saturating_add(1);
            let der = pem_lines(body)
                .and_then(|b64| decode_base64(&b64, Base64::Lenient))
                .ok_or_else(|| KeyError::NotEd25519 {
                    block,
                    why: "its body is not base64 in lines of their own".to_owned(),
                })?;
            let key = PublicKey::from_spki_der(&der)
                .map_err(|why| KeyError::NotEd25519 { block, why })?;
            keys.push(key);
            rest = next;
        } else {
            // No END right after the body: look for the next BEGIN from the
            // character after this one, as a regular expression would.
            rest = rest.get(at.saturating_add(1)..).unwrap_or_default();
        }
    }
    if keys.is_empty() {
        return Err(KeyError::NoPublicKey);
    }
    Ok(keys)
}

/// The base64 of a PEM block's body, the text between its BEGIN and END
/// markers, as OpenSSL (which the reference reads keys with) takes it: the
/// BEGIN line holds nothing more but white space, the base64 is on lines of
/// its own, none of them blank, and END begins a line. Lines end in a line
/// feed or a carriage return and a line feed.
fn pem_lines(body: &str) -> Option<String> {
    let mut lines = body.split('\n');
    let begin_line = lines.next()?;
    if !begin_line.trim_matches([' ', '\t', '\r']).is_empty() {
        return None;
    }
    let rest: Vec<&str> = lines.collect();
    let (end_line, middle) = rest.split_last()?;
    if !end_line.is_empty() || middle.is_empty() {
        return None;
    }
    let mut b64 = String::new();
    for line in middle {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim_matches([' ', '\t']).is_empty() {
            return None;
        }
        b64.push_str(line);
    }
    Some(b64)
}

/// The 64 bytes of an anchor's signature when it is `ed25519:` and their
/// canonical base64 (RFC 4648 §4): 86 characters of the standard alphabet
/// and `==`, the unused low bits of the last character zero.
#[must_use]
pub fn parse_signature(signature: &str) -> Option<[u8; 64]> {
    let b64 = signature.strip_prefix("ed25519:")?;
    if b64.len() != 88 || !b64.ends_with("==") {
        return None;
    }
    let bytes = decode_base64(b64, Base64::Canonical)?;
    <[u8; 64]>::try_from(bytes).ok()
}

/// How strictly base64 is read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Base64 {
    /// No white space, and the unused bits of the last character are zero.
    Canonical,
    /// White space (space, tab, line feed, carriage return) is skipped, and
    /// the unused bits are not looked at, as OpenSSL reads a PEM body.
    Lenient,
}

fn sextet(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c.checked_sub(b'A')?,
        b'a'..=b'z' => c.checked_sub(b'a')?.checked_add(26)?,
        b'0'..=b'9' => c.checked_sub(b'0')?.checked_add(52)?,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Standard base64 with `=` padding to a multiple of four characters.
fn decode_base64(text: &str, mode: Base64) -> Option<Vec<u8>> {
    let chars: Vec<u8> = match mode {
        Base64::Canonical => text.bytes().collect(),
        Base64::Lenient => text
            .bytes()
            .filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
            .collect(),
    };
    if chars.is_empty() || !chars.len().is_multiple_of(4) {
        return None;
    }
    let pad = chars.iter().rev().take_while(|&&c| c == b'=').count();
    if pad > 2 {
        return None;
    }
    let data = chars.get(..chars.len().saturating_sub(pad))?;
    let mut out = Vec::with_capacity(data.len());
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in data {
        acc = (acc & 0xffff).checked_shl(6)? | sextet(c)?;
        bits = bits.checked_add(6)?;
        if bits >= 8 {
            bits = bits.checked_sub(8)?;
            out.push(u8::try_from(acc.checked_shr(bits)? & 0xff).ok()?);
        }
    }
    // What is left are the unused low bits of the last character.
    let unused = 1_u32.checked_shl(bits)?.checked_sub(1)?;
    if mode == Base64::Canonical && acc & unused != 0 {
        return None;
    }
    Some(out)
}
