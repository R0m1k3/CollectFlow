//! Messages NTLM — traduction octet pour octet de `httpntlm/ntlm.js` (v1.8.13),
//! le module npm qu'utilisait `qlik-client.ts`.
//!
//! Le serveur Qlik a été validé avec exactement ces messages (login `FFSCH`,
//! domaine VIDE, comme `requests_ntlm("FFSCH", pwd)` ; forcer `FOIRFOUILLE` → 401).
//! On reproduit donc à l'identique :
//!   - type 1 : drapeaux `NTLM_TYPE1_FLAGS` (moins « OEM domain supplied » sans
//!     domaine), version 5.1 build 2600, domaine et poste passés par `escape()`
//!     puis mis en majuscules ;
//!   - type 3 : NTLMv2 dès que le serveur annonce « extended security » ET
//!     fournit un `targetInfo` ; NTLM2 Session Response si « extended security »
//!     sans `targetInfo` ; sinon réponses LM/NT v1 (DES).
//!
//! Les tests comparent la sortie aux messages produits par `ntlm.js` sous Node
//! avec aléa et horloge figés.

use base64::Engine as _;
use des::cipher::{BlockEncrypt, KeyInit};
use hmac::{Hmac, Mac};
use md4::{Digest, Md4};

const NEGOTIATE_UNICODE: u32 = 0x0000_0001;
const NEGOTIATE_OEM: u32 = 0x0000_0002;
const REQUEST_TARGET: u32 = 0x0000_0004;
const NEGOTIATE_NTLM: u32 = 0x0000_0200;
const NEGOTIATE_OEM_DOMAIN_SUPPLIED: u32 = 0x0000_1000;
const NEGOTIATE_OEM_WORKSTATION_SUPPLIED: u32 = 0x0000_2000;
const NEGOTIATE_ALWAYS_SIGN: u32 = 0x0000_8000;
const NEGOTIATE_EXTENDED_SECURITY: u32 = 0x0008_0000;
const NEGOTIATE_TARGET_INFO: u32 = 0x0080_0000;
const NEGOTIATE_VERSION: u32 = 0x0200_0000;
const NEGOTIATE_128: u32 = 0x2000_0000;
const NEGOTIATE_56: u32 = 0x8000_0000;

const TYPE1_FLAGS: u32 = NEGOTIATE_UNICODE
    + NEGOTIATE_OEM
    + REQUEST_TARGET
    + NEGOTIATE_NTLM
    + NEGOTIATE_OEM_DOMAIN_SUPPLIED
    + NEGOTIATE_OEM_WORKSTATION_SUPPLIED
    + NEGOTIATE_ALWAYS_SIGN
    + NEGOTIATE_EXTENDED_SECURITY
    + NEGOTIATE_VERSION
    + NEGOTIATE_128
    + NEGOTIATE_56;

const TYPE2_FLAGS: u32 = NEGOTIATE_UNICODE
    + REQUEST_TARGET
    + NEGOTIATE_NTLM
    + NEGOTIATE_ALWAYS_SIGN
    + NEGOTIATE_EXTENDED_SECURITY
    + NEGOTIATE_TARGET_INFO
    + NEGOTIATE_VERSION
    + NEGOTIATE_128
    + NEGOTIATE_56;

/// Version annoncée par `ntlm.js` : Windows XP (5.1 build 2600), révision NTLM 15.
const VERSION: [u8; 8] = [5, 1, 0x28, 0x0a, 0, 0, 0, 15];

/// `escape()` JavaScript (unités UTF-16, `%XX` / `%uXXXX`).
pub fn js_escape(s: &str) -> String {
    let mut out = String::new();
    for u in s.encode_utf16() {
        let c = char::from_u32(u as u32).filter(|c| c.is_ascii_alphanumeric() || "@*_+-./".contains(*c));
        match c {
            Some(c) => out.push(c),
            None if u < 256 => out.push_str(&format!("%{u:02X}")),
            None => out.push_str(&format!("%u{u:04X}")),
        }
    }
    out
}

fn utf16le(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
}

/// Encodage `'ascii'` de Node : octet de poids faible de chaque unité UTF-16.
fn node_ascii(s: &str) -> Vec<u8> {
    s.encode_utf16().map(|u| (u & 0xff) as u8).collect()
}

fn push_u16(buf: &mut Vec<u8>, v: usize) {
    buf.extend_from_slice(&(v as u16).to_le_bytes());
}

fn push_u32(buf: &mut Vec<u8>, v: usize) {
    buf.extend_from_slice(&(v as u32).to_le_bytes());
}

/// Message de négociation (type 1), préfixé `NTLM `.
pub fn create_type1_message(domain: &str, workstation: &str) -> String {
    let domain = js_escape(&domain.to_uppercase());
    let workstation = js_escape(&workstation.to_uppercase());
    const BODY_LENGTH: usize = 40;
    let mut flags = TYPE1_FLAGS;
    if domain.is_empty() {
        flags -= NEGOTIATE_OEM_DOMAIN_SUPPLIED;
    }
    let mut buf = Vec::with_capacity(BODY_LENGTH + domain.len() + workstation.len());
    buf.extend_from_slice(b"NTLMSSP\0");
    push_u32(&mut buf, 1);
    buf.extend_from_slice(&flags.to_le_bytes());
    push_u16(&mut buf, domain.len());
    push_u16(&mut buf, domain.len());
    push_u32(&mut buf, BODY_LENGTH + workstation.len());
    push_u16(&mut buf, workstation.len());
    push_u16(&mut buf, workstation.len());
    push_u32(&mut buf, BODY_LENGTH);
    buf.extend_from_slice(&VERSION);
    buf.extend_from_slice(workstation.as_bytes());
    buf.extend_from_slice(domain.as_bytes());
    format!("NTLM {}", base64::engine::general_purpose::STANDARD.encode(buf))
}

/// Message de défi (type 2) envoyé par le serveur.
#[derive(Debug, Clone)]
pub struct Type2Message {
    pub negotiate_flags: u32,
    pub server_challenge: [u8; 8],
    /// Présent dès que le serveur annonce `NegotiateTargetInfo` (même vide :
    /// un `Buffer` vide est « vrai » en JS, d'où le choix de NTLMv2).
    pub target_info: Option<Vec<u8>>,
}

fn slice_clamp(buf: &[u8], debut: usize, fin: usize) -> Vec<u8> {
    let debut = debut.min(buf.len());
    let fin = fin.clamp(debut, buf.len());
    buf[debut..fin].to_vec()
}

fn decode_base64_tolerant(s: &str) -> Vec<u8> {
    // Node ignore les caractères hors alphabet et le remplissage manquant.
    let propre: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/').collect();
    base64::engine::general_purpose::STANDARD_NO_PAD.decode(propre.as_bytes()).unwrap_or_default()
}

/// Lit le message type 2 d'un en-tête `WWW-Authenticate` (`NTLM <base64>`).
pub fn parse_type2_message(raw: &str) -> anyhow::Result<Type2Message> {
    let Some(pos) = raw.find("NTLM ") else {
        anyhow::bail!("Couldn't find NTLM in the message type2 coming from the server");
    };
    // Plusieurs défis joints par « , » : on s'arrête au premier séparateur.
    let b64 = raw[pos + 5..].split([',', ' ']).next().unwrap_or("").trim();
    if b64.is_empty() {
        anyhow::bail!("Couldn't find NTLM in the message type2 coming from the server");
    }
    let buf = decode_base64_tolerant(b64);
    let lire_u16 = |o: usize| buf.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize).unwrap_or(0);
    let lire_u32 = |o: usize| buf.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(0);
    if buf.len() < 32 || lire_u16(8) != 2 {
        anyhow::bail!("Server didn't return a type 2 message");
    }
    let negotiate_flags = lire_u32(20);
    let mut server_challenge = [0u8; 8];
    server_challenge.copy_from_slice(&buf[24..32]);
    let target_info = if negotiate_flags & NEGOTIATE_TARGET_INFO != 0 {
        let len = lire_u16(40);
        let off = lire_u32(44) as usize;
        Some(slice_clamp(&buf, off, off + len))
    } else {
        None
    };
    Ok(Type2Message { negotiate_flags, server_challenge, target_info })
}

/// 7 octets → clé DES de 8 octets (un bit nul inséré tous les 7 bits).
fn insert_zeros_every_7_bits(src: &[u8]) -> [u8; 8] {
    let mut bits = Vec::with_capacity(64);
    for b in src.iter().take(7) {
        for i in (0..8).rev() {
            bits.push((b >> i) & 1);
        }
    }
    let mut out = [0u8; 8];
    for (k, octet) in out.iter_mut().enumerate() {
        let mut v = 0u8;
        for j in 0..7 {
            v = (v << 1) | bits.get(k * 7 + j).copied().unwrap_or(0);
        }
        *octet = v << 1;
    }
    out
}

fn des_encrypt(key7: &[u8], data: &[u8]) -> [u8; 8] {
    let key = insert_zeros_every_7_bits(key7);
    let cipher = des::Des::new_from_slice(&key).expect("clé DES de 8 octets");
    let mut block = des::cipher::generic_array::GenericArray::clone_from_slice(&data[..8]);
    cipher.encrypt_block(&mut block);
    block.into()
}

fn create_lm_hashed_password_v1(password: &str) -> Vec<u8> {
    let bytes = node_ascii(&password.to_uppercase());
    let mut padded = [0u8; 14];
    let n = bytes.len().min(14);
    padded[..n].copy_from_slice(&bytes[..n]);
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&des_encrypt(&padded[0..7], b"KGS!@#$%"));
    out.extend_from_slice(&des_encrypt(&padded[7..14], b"KGS!@#$%"));
    out
}

fn create_nt_hashed_password_v1(password: &str) -> Vec<u8> {
    Md4::digest(utf16le(password)).to_vec()
}

fn calc_resp(password_hash: &[u8], server_challenge: &[u8]) -> Vec<u8> {
    let mut padded = [0u8; 21];
    let n = password_hash.len().min(21);
    padded[..n].copy_from_slice(&password_hash[..n]);
    let mut out = Vec::with_capacity(24);
    for k in 0..3 {
        out.extend_from_slice(&des_encrypt(&padded[k * 7..k * 7 + 7], &server_challenge[..8]));
    }
    out
}

fn hmac_md5(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <Hmac<md5::Md5> as Mac>::new_from_slice(key).expect("HMAC accepte toute clé");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn ntlm2sr_calc_resp(response_key_nt: &[u8], server_challenge: &[u8; 8], client_challenge: &[u8; 8]) -> (Vec<u8>, Vec<u8>) {
    let mut lm = vec![0u8; 24];
    lm[..8].copy_from_slice(client_challenge);
    let mut h = md5::Md5::new();
    h.update(server_challenge);
    h.update(client_challenge);
    let sess = h.finalize();
    let nt = calc_resp(response_key_nt, &sess[..8]);
    (lm, nt)
}

fn calc_ntlmv2_resp(
    pwhash: &[u8],
    username: &str,
    domain: &str,
    target_info: &[u8],
    server_challenge: &[u8; 8],
    client_challenge: &[u8; 8],
    now_ms: u64,
) -> (Vec<u8>, Vec<u8>) {
    // NTOWFv2
    let response_key = hmac_md5(pwhash, &utf16le(&format!("{}{}", username.to_uppercase(), domain)));
    let mut lm = hmac_md5(&response_key, &[server_challenge.as_slice(), client_challenge.as_slice()].concat());
    lm.extend_from_slice(client_challenge);

    // 11644473600000 = écart en ms entre 1601 et 1970.
    let timestamp = (now_ms + 11_644_473_600_000) * 10_000;
    let mut temp = vec![0x01, 0x01, 0x00, 0x00, 0, 0, 0, 0];
    temp.extend_from_slice(&timestamp.to_le_bytes());
    temp.extend_from_slice(client_challenge);
    temp.extend_from_slice(&[0, 0, 0, 0]);
    temp.extend_from_slice(target_info);
    temp.extend_from_slice(&[0, 0, 0, 0]);
    let mut nt = hmac_md5(&response_key, &[server_challenge.as_slice(), &temp].concat());
    nt.extend_from_slice(&temp);
    (lm, nt)
}

/// Message d'authentification (type 3), préfixé `NTLM ` — défi client aléatoire
/// et horodatage courant, comme `ntlm.js`.
pub fn create_type3_message(msg2: &Type2Message, username: &str, password: &str, domain: &str, workstation: &str) -> String {
    let client_challenge: [u8; 8] = rand::random();
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    create_type3_message_with(msg2, username, password, domain, workstation, client_challenge, now_ms)
}

/// Variante déterministe de [`create_type3_message`] (tests).
pub fn create_type3_message_with(
    msg2: &Type2Message,
    username: &str,
    password: &str,
    domain: &str,
    workstation: &str,
    client_challenge: [u8; 8],
    now_ms: u64,
) -> String {
    let nonce = &msg2.server_challenge;
    let is_unicode = msg2.negotiate_flags & NEGOTIATE_UNICODE != 0;
    let extended = msg2.negotiate_flags & NEGOTIATE_EXTENDED_SECURITY != 0;
    const BODY_LENGTH: usize = 72;

    let domain_name = js_escape(&domain.to_uppercase());
    let workstation = js_escape(&workstation.to_uppercase());
    let enc = |s: &str| if is_unicode { utf16le(s) } else { node_ascii(s) };
    let workstation_bytes = enc(&workstation);
    let domain_bytes = enc(&domain_name);
    let username_bytes = enc(username);
    let session_key_bytes: Vec<u8> = Vec::new();

    let nt_hash = create_nt_hashed_password_v1(password);
    let (lm_resp, nt_resp) = if extended {
        // NTLMv2 dès que le serveur fournit le targetInfo (comme curl) ; sinon
        // NTLMv1 avec « extended security » (NTLM2 Session Response).
        match &msg2.target_info {
            Some(ti) => calc_ntlmv2_resp(&nt_hash, username, &domain_name, ti, nonce, &client_challenge, now_ms),
            None => ntlm2sr_calc_resp(&nt_hash, nonce, &client_challenge),
        }
    } else {
        (calc_resp(&create_lm_hashed_password_v1(password), nonce), calc_resp(&nt_hash, nonce))
    };

    let base = BODY_LENGTH + domain_bytes.len() + username_bytes.len() + workstation_bytes.len();
    let mut buf = Vec::with_capacity(base + lm_resp.len() + nt_resp.len());
    buf.extend_from_slice(b"NTLMSSP\0");
    push_u32(&mut buf, 3);
    push_u16(&mut buf, lm_resp.len());
    push_u16(&mut buf, lm_resp.len());
    push_u32(&mut buf, base);
    push_u16(&mut buf, nt_resp.len());
    push_u16(&mut buf, nt_resp.len());
    push_u32(&mut buf, base + lm_resp.len());
    push_u16(&mut buf, domain_bytes.len());
    push_u16(&mut buf, domain_bytes.len());
    push_u32(&mut buf, BODY_LENGTH);
    push_u16(&mut buf, username_bytes.len());
    push_u16(&mut buf, username_bytes.len());
    push_u32(&mut buf, BODY_LENGTH + domain_bytes.len());
    push_u16(&mut buf, workstation_bytes.len());
    push_u16(&mut buf, workstation_bytes.len());
    push_u32(&mut buf, BODY_LENGTH + domain_bytes.len() + username_bytes.len());
    push_u16(&mut buf, session_key_bytes.len());
    push_u16(&mut buf, session_key_bytes.len());
    push_u32(&mut buf, base + lm_resp.len() + nt_resp.len());
    let flags = if is_unicode { TYPE2_FLAGS } else { TYPE2_FLAGS - NEGOTIATE_UNICODE };
    buf.extend_from_slice(&flags.to_le_bytes());
    buf.extend_from_slice(&VERSION);
    buf.extend_from_slice(&domain_bytes);
    buf.extend_from_slice(&username_bytes);
    buf.extend_from_slice(&workstation_bytes);
    buf.extend_from_slice(&lm_resp);
    buf.extend_from_slice(&nt_resp);
    buf.extend_from_slice(&session_key_bytes);
    format!("NTLM {}", base64::engine::general_purpose::STANDARD.encode(buf))
}

#[cfg(test)]
mod tests {
    //! Références produites par `node_modules/httpntlm/ntlm.js` (v1.8.13) avec
    //! `Math.random` figé (octets 37·k mod 256) et `Date.now() = 1781600000123`.
    use super::*;

    const CLIENT: [u8; 8] = [0x25, 0x4a, 0x6f, 0x94, 0xb9, 0xde, 0x03, 0x28];
    const NOW: u64 = 1_781_600_000_123;

    #[test]
    fn type1_identique_a_ntlm_js() {
        assert_eq!(create_type1_message("", ""), "NTLM TlRMTVNTUAABAAAAB6IIogAAAAAoAAAAAAAAACgAAAAFASgKAAAADw==");
        assert_eq!(
            create_type1_message("foirfouille", "poste-1"),
            "NTLM TlRMTVNTUAABAAAAB7IIogsACwAvAAAABwAHACgAAAAFASgKAAAAD1BPU1RFLTFGT0lSRk9VSUxMRQ=="
        );
    }

    fn type3(type2: &str, user: &str, pwd: &str, dom: &str, ws: &str) -> String {
        let msg2 = parse_type2_message(type2).unwrap();
        create_type3_message_with(&msg2, user, pwd, dom, ws, CLIENT, NOW)
    }

    const T2_V2: &str =
        "NTLM TlRMTVNTUAACAAAADgAOADAAAAAVgoniASNFZ4mrze8AAAAAAAAAACQAJAA+AAAARABPAE0AQQBJAE4ARQACAA4ARABPAE0AQQBJAE4AAQAMAFMARQBSAFYARQBSAAAAAAA=";

    #[test]
    fn type3_ntlmv2_identique_a_ntlm_js() {
        assert_eq!(
            type3(T2_V2, "FFSCH", "Mot2Passe!", "", ""),
            "NTLM TlRMTVNTUAADAAAAGAAYAFIAAABUAFQAagAAAAAAAABIAAAACgAKAEgAAAAAAAAAUgAAAAAAAAC+AAAABYKIogUBKAoAAAAPRgBGAFMAQwBIAMebHM0wuVW53i9NaYVnDM0lSm+Uud4DKFKnk/6apESm+PHJ3XiP8I8BAQAAAAAAALDEopRt/dwBJUpvlLneAygAAAAAAgAOAEQATwBNAEEASQBOAAEADABTAEUAUgBWAEUAUgAAAAAAAAAAAA=="
        );
        assert_eq!(
            type3(T2_V2, "ffsch", "pässwörd", "foirFouille", "ws é"),
            "NTLM TlRMTVNTUAADAAAAGAAYAHgAAABUAFQAkAAAABYAFgBIAAAACgAKAF4AAAAQABAAaAAAAAAAAADkAAAABYKIogUBKAoAAAAPRgBPAEkAUgBGAE8AVQBJAEwATABFAGYAZgBzAGMAaABXAFMAJQAyADAAJQBDADkA2c8BUzjri/Vbm9o3osFxDiVKb5S53gMoWbFIumwCV7VyC/+QpeFgkwEBAAAAAAAAsMSilG393AElSm+Uud4DKAAAAAACAA4ARABPAE0AQQBJAE4AAQAMAFMARQBSAFYARQBSAAAAAAAAAAAA"
        );
    }

    #[test]
    fn type3_ntlm2_session_identique_a_ntlm_js() {
        assert_eq!(
            type3("NTLM TlRMTVNTUAACAAAADgAOADAAAAAVggjiASNFZ4mrze8AAAAAAAAAAAAAAAAAAAAARABPAE0AQQBJAE4ARQA=", "FFSCH", "Mot2Passe!", "", ""),
            "NTLM TlRMTVNTUAADAAAAGAAYAFIAAAAYABgAagAAAAAAAABIAAAACgAKAEgAAAAAAAAAUgAAAAAAAACCAAAABYKIogUBKAoAAAAPRgBGAFMAQwBIACVKb5S53gMoAAAAAAAAAAAAAAAAAAAAAEkBa2FWIubP7jtR0YUCzhOojjrIJ/b0zg=="
        );
    }

    #[test]
    fn type3_ntlmv1_identique_a_ntlm_js() {
        assert_eq!(
            type3("NTLM TlRMTVNTUAACAAAADgAOADAAAAACAgAAASNFZ4mrze8AAAAAAAAAAAAAAAAAAAAARABPAE0AQQBJAE4ARQA=", "FFSCH", "Mot2Passe!", "dom", "ws"),
            "NTLM TlRMTVNTUAADAAAAGAAYAFIAAAAYABgAagAAAAMAAwBIAAAABQAFAEsAAAACAAIAUAAAAAAAAACCAAAABIKIogUBKAoAAAAPRE9NRkZTQ0hXUxOnemDuiKIblbqFa0gPlHCgLteOCjDT8ybUs0Z210bpm9YSI+44nltXbx25eedv1g=="
        );
        assert_eq!(
            type3("NTLM TlRMTVNTUAACAAAADgAOADAAAAABAgAAASNFZ4mrze8AAAAAAAAAAAAAAAAAAAAARABPAE0AQQBJAE4ARQA=", "Utilisateur", "un mot de passe tres long", "", ""),
            "NTLM TlRMTVNTUAADAAAAGAAYAF4AAAAYABgAdgAAAAAAAABIAAAAFgAWAEgAAAAAAAAAXgAAAAAAAACOAAAABYKIogUBKAoAAAAPVQB0AGkAbABpAHMAYQB0AGUAdQByAApLfYq11cQZCEfoqsrdSUT3L9f12IEFMjyUawPg7lXzmV17ourU8IkTxBWsCur8CA=="
        );
    }

    #[test]
    fn type2_invalide() {
        assert!(parse_type2_message("Negotiate").is_err());
        assert!(parse_type2_message("NTLM TlRMTVNTUAABAAAAB6IIogAAAAAoAAAAAAAAACgAAAAFASgKAAAADw==").is_err());
        // Plusieurs défis dans le même en-tête (Node les joint par « , »).
        assert!(parse_type2_message(&format!("Negotiate, {T2_V2}")).is_ok());
    }

    #[test]
    fn escape_facon_js() {
        assert_eq!(js_escape("WS É"), "WS%20%C9");
        assert_eq!(js_escape("a€b"), "a%u20ACb");
        assert_eq!(js_escape("@*_+-./"), "@*_+-./");
    }

    /// Recalcule les références avec Node quand il est disponible
    /// (`cargo test -- --ignored ntlm_js_en_direct`).
    #[test]
    #[ignore]
    fn ntlm_js_en_direct() {
        let script = r#"
            const ntlm = require(process.argv[1]);
            let k = 0; Math.random = () => { k++; return ((k * 37) % 256) / 256 + 0.0001; };
            Date.now = () => 1781600000123;
            const t2 = process.argv[2];
            const m = ntlm.parseType2Message(t2, (e) => { throw e; });
            console.log(ntlm.createType1Message({ domain: 'foirfouille', workstation: 'poste-1' }));
            console.log(ntlm.createType3Message(m, { username: 'FFSCH', password: 'Mot2Passe!', domain: 'Dom', workstation: 'PC' }));
        "#;
        let module = std::env::var("HTTPNTLM_JS").unwrap_or_else(|_| "/home/user/CollectFlow/node_modules/httpntlm/ntlm.js".into());
        let out = std::process::Command::new("node").args(["-e", script, &module, T2_V2]).output().expect("node");
        let texte = String::from_utf8(out.stdout).unwrap();
        let lignes: Vec<&str> = texte.lines().collect();
        assert_eq!(lignes[0], create_type1_message("foirfouille", "poste-1"));
        assert_eq!(lignes[1], type3(T2_V2, "FFSCH", "Mot2Passe!", "Dom", "PC"));
    }
}
