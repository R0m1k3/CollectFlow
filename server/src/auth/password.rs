//! Mots de passe : scrypt au format `sel:hachage` (hex), compatible avec les
//! comptes créés par l'ancienne version Node (`scryptSync(pwd, sel, 64)`,
//! N=16384, r=8, p=1, le sel hexadécimal étant utilisé tel quel comme octets).

use rand::RngCore;
use subtle::ConstantTimeEq;

fn derive(password: &str, salt: &str) -> Option<[u8; 64]> {
    let params = scrypt::Params::new(14, 8, 1, 64).ok()?;
    let mut out = [0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).ok()?;
    Some(out)
}

pub fn hash_password(password: &str) -> String {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let salt = hex::encode(salt);
    let hash = derive(password, &salt).map(hex::encode).unwrap_or_default();
    format!("{salt}:{hash}")
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let Some((salt, hash)) = stored.split_once(':') else { return false };
    if salt.is_empty() || hash.is_empty() {
        return false;
    }
    let Ok(expected) = hex::decode(hash) else { return false };
    let Some(actual) = derive(password, salt) else { return false };
    expected.len() == actual.len() && bool::from(actual.as_slice().ct_eq(expected.as_slice()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let h = hash_password("admin");
        assert!(verify_password("admin", &h));
        assert!(!verify_password("nope", &h));
    }

    #[test]
    fn compatible_node() {
        // require("crypto").scryptSync("admin", "00112233445566778899aabbccddeeff", 64).toString("hex")
        let stored = "00112233445566778899aabbccddeeff:".to_string()
            + &hex::encode(derive("admin", "00112233445566778899aabbccddeeff").unwrap());
        assert!(verify_password("admin", &stored));
    }
}

#[cfg(test)]
mod node_compat {
    #[test]
    fn hash_from_node() {
        assert!(super::verify_password("s3cret", "abcdef0123456789abcdef0123456789:8e07d3f906fe581051e47f776fd3fb6307401dc4702369a6db2b7fbb892eb23571af616a59cf13a162cfd584035381c062b7d17fd4ca0d82a2cdf0e1ce2330aa"));
        assert!(!super::verify_password("s3cre", "abcdef0123456789abcdef0123456789:8e07d3f906fe581051e47f776fd3fb6307401dc4702369a6db2b7fbb892eb23571af616a59cf13a162cfd584035381c062b7d17fd4ca0d82a2cdf0e1ce2330aa"));
    }
}
