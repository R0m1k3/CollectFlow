//! Client Qlik Sense — configuration, types partagés et authentification
//! (port de `src/lib/qlik-client.ts`).
//!
//! Récupère par produit (clé = code centrale via la dimension "Article Code") :
//!   - CA réseau, Qté vendue réseau, Nb magasins travaillant le produit.
//!
//! Auth = NTLM (Qlik Sense Enterprise on Windows) via flux ticket SSO :
//!   1. GET /hub/ (non authentifié) -> 302 vers le proxy forms, on extrait le targetId
//!   2. NTLM sur /internal_windows_authentication/?targetId=... -> 302 /hub/?qlikTicket=XXX
//!   3. GET /hub/?qlikTicket=XXX -> Qlik pose le cookie X-Qlik-Session
//! Le cookie + Xrfkey servent ensuite pour QRS (REST) et l'Engine API (websocket).
//!
//! L'extraction passe par Chromium (`playwright.rs`) : le proxy Qlik refuse un
//! websocket « raw » côté serveur (403). Le `fetchNetworkMetrics` par websocket
//! direct du TS n'était appelé nulle part (la Grille a sa propre fonction
//! homonyme, qui lit le cache) : il n'est pas porté.
//!
//! Tout est paramétrable par variables d'environnement (défauts = discovery 2026-06-20).

use super::jsnum;
use super::ntlm;
use anyhow::{anyhow, bail, Context};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Config — défauts issus de la discovery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QlikConfig {
    pub host: String,
    pub user: String,
    #[serde(skip_serializing)]
    pub password: String,
    /// Vide par défaut (NTLM sans domaine, comme requests_ntlm).
    pub domain: String,
    pub workstation: String,
    /// GUID app "Magasins Vision Consolidée" (article x réseau).
    pub app_network: String,
    /// Master dimension "Article Code".
    pub dim_code_article_id: String,
    /// Master measure "CA N".
    pub meas_ca_id: String,
    /// Master measure "Quantité N".
    pub meas_qte_id: String,
    /// Master measure "Magasin Ventes Nb N".
    pub meas_nb_mag_id: String,
    /// Master measure "CA par Magasin N".
    pub meas_ca_mag_id: String,
    /// Master measure "Marge % N".
    pub meas_marge_pct_id: String,
    pub tls_insecure: bool,
    pub timeout_ms: u64,
}

/// `process.env.X || défaut` (une valeur vide compte comme absente).
fn env_ou(nom: &str) -> Option<String> {
    std::env::var(nom).ok().filter(|v| !v.is_empty())
}

/// `process.env.X ?? défaut` (une valeur vide est conservée).
fn env_nul(nom: &str, defaut: &str) -> String {
    std::env::var(nom).unwrap_or_else(|_| defaut.to_string())
}

/// Priorité : réglages UI (`data/.db-config.json`) > env > défaut.
pub fn get_qlik_config() -> QlikConfig {
    let f = crate::config::read_config();
    let fichier = |v: Option<String>| v.filter(|s| !s.is_empty());
    let timeout = super::date_range::js_number(&env_nul("QLIK_TIMEOUT_MS", "60000"));
    QlikConfig {
        host: fichier(f.qlik_host).or_else(|| env_ou("QLIK_HOST")).unwrap_or_else(|| "reporting-magasins.lafoirfouille.fr".into()),
        user: fichier(f.qlik_user).or_else(|| env_ou("QLIK_USER")).unwrap_or_else(|| "FFSCH".into()),
        password: fichier(f.qlik_password).or_else(|| env_ou("QLIK_PWD")).unwrap_or_default(),
        domain: env_nul("QLIK_DOMAIN", ""),
        workstation: env_nul("QLIK_WORKSTATION", ""),
        app_network: env_nul("QLIK_APP_NETWORK", "9872ee6e-d64a-4b43-984a-076bf1f7f647"),
        // qIds engine (master items de l'app "Magasins Vision Consolidée")
        dim_code_article_id: env_nul("QLIK_DIM_CODE_ARTICLE_ID", "yesCP"),
        meas_ca_id: env_nul("QLIK_MEAS_CA_ID", "JhqJ"),
        meas_qte_id: env_nul("QLIK_MEAS_QTE_ID", "41516861-5997-4635-8187-3643a2bde422"),
        meas_nb_mag_id: env_nul("QLIK_MEAS_NBMAG_ID", "yNBLjc"),
        // Master GUIDs de l'app "Magasins Vision Consolidée" (9872ee6e). Si l'engine
        // les refuse (qId court attendu), override via env après discovery.
        meas_ca_mag_id: env_nul("QLIK_MEAS_CAMAG_ID", "16778c00-a4e0-41c7-ab1c-179810d78172"),
        meas_marge_pct_id: env_nul("QLIK_MEAS_MARGEPCT_ID", "ea1e8feb-49ba-4eb3-8db6-72dcfb4c1222"),
        tls_insecure: env_nul("QLIK_TLS_INSECURE", "true") == "true",
        // `Number(...)` invalide donnait NaN côté TS : on retombe sur le défaut.
        timeout_ms: if timeout.is_finite() && timeout > 0.0 { timeout as u64 } else { 60_000 },
    }
}

// ---------------------------------------------------------------------------
// Types partagés
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetric {
    pub code_centrale: String,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub ca_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub qte_reseau: f64,
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub nb_magasins_reseau: f64,
    /// CA moyen par magasin (productivité normalisée présence)
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub ca_par_magasin_reseau: f64,
    /// Taux de marge réseau (ratio brut Qlik, ex 0.32 = 32%)
    #[serde(serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub marge_pct_reseau: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub periode: Option<String>,
    /// Quantité vendue réseau par mois : { "YYYY-MM": qté }. Rempli si sync avec filtre Date.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_map", deserialize_with = "jsnum::de_map")]
    pub qte_by_month: Option<BTreeMap<String, f64>>,
    /// Détail mensuel complet : { "YYYY-MM": { qte, ca, nbMag, caMag, margePct } }.
    ///
    /// Le cube mensuel Qlik renvoie déjà ces 5 mesures par (Article Code, Mois).
    /// Lors d'une synchronisation datée validée, les 12 mois complets sont
    /// toujours présents ; un mois sans fait est explicitement représenté à 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics_by_month: Option<BTreeMap<String, QlikMonthMetrics>>,
    /// Libellé de l'article côté Qlik. Renseigné uniquement par la recherche
    /// produit, qui interroge la dimension libellé ; la sync fournisseur ne le
    /// connaît pas et le laisse absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub libelle_reseau: Option<String>,
    /// Fournisseur de l'article côté Qlik, même origine que `libelle_reseau`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fournisseur_reseau: Option<String>,
}

/// Les mesures réseau Qlik pour un produit sur un mois donné.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QlikMonthMetrics {
    /// Quantité vendue réseau — toujours présente.
    /// Absente du JSON (objet mensuel incomplet) : 0, comme `fini(undefined)` côté TS.
    #[serde(default, serialize_with = "jsnum::ser", deserialize_with = "jsnum::de")]
    pub qte: f64,
    /// CA réseau du mois.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub ca: Option<f64>,
    /// Nombre de magasins ayant vendu le produit ce mois-là.
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub nb_mag: Option<f64>,
    /// CA moyen par magasin sur le mois (mesure Qlik brute).
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub ca_mag: Option<f64>,
    /// Taux de marge réseau du mois (ratio brut Qlik, ex 0.32 = 32%).
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "jsnum::ser_opt", deserialize_with = "jsnum::de_opt")]
    pub marge_pct: Option<f64>,
}

/// Produit réseau tel que renvoyé par la **recherche** Qlik (page Recherche réseau).
///
/// Différence clé avec `NetworkMetric` : ces produits viennent du catalogue Qlik
/// du réseau, pas de notre catalogue local. Ils peuvent donc être totalement
/// inconnus de FF Nancy — d'où le libellé, qui n'est pas récupérable en base.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProduct {
    #[serde(flatten)]
    pub metric: NetworkMetric,
    /// Libellé article tel qu'il apparaît dans Qlik (dimension « Article »).
    pub libelle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fournisseur: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub famille: Option<String>,
}

/// Clé anti-CSRF Qlik : 16 caractères alphanumériques.
pub fn make_xrfkey() -> String {
    let octets: [u8; 12] = rand::random();
    let mut k: String = base64::engine::general_purpose::STANDARD.encode(octets).chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    while k.len() < 16 {
        k.push('0');
    }
    k
}

// ---------------------------------------------------------------------------
// 1. Auth NTLM -> ticket SSO -> cookie de session
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct QlikSession {
    /// `X-Qlik-Session=…` (paires `nom=valeur` jointes par `; `).
    pub cookie: String,
    pub xrfkey: String,
}

/// Réponse HTTP minimale (statut + en-têtes) d'un échange NTLM.
struct ReponseNtlm {
    status: u16,
    headers: hyper::HeaderMap,
}

/// Vérificateur TLS qui accepte tout certificat (`tlsInsecure`, défaut true :
/// le serveur Qlik interne présente un certificat non reconnu).
#[derive(Debug)]
struct SansVerification(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for SansVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn config_tls(insecure: bool) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder =
        rustls::ClientConfig::builder_with_provider(provider.clone()).with_safe_default_protocol_versions().expect("versions TLS par défaut");
    let mut cfg = if insecure {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(SansVerification(provider))).with_no_client_auth()
    } else {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        builder.with_root_certificates(roots).with_no_client_auth()
    };
    // HTTP/1.1 uniquement : NTLM authentifie la CONNEXION, pas la requête.
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    cfg
}

/// Connexion HTTP/1.1 dédiée (TLS si https) : le défi NTLM type 2 n'est valable
/// que sur la connexion TCP qui l'a reçu, le type 3 doit donc partir sur la même.
/// (`httpntlm` utilisait pour cela un agent keep-alive.)
async fn connexion_dediee(
    url: &reqwest::Url,
    cfg: &QlikConfig,
) -> anyhow::Result<hyper::client::conn::http1::SendRequest<http_body_util::Empty<hyper::body::Bytes>>> {
    let host = url.host_str().ok_or_else(|| anyhow!("[qlik] URL sans hôte : {url}"))?.to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await.with_context(|| format!("[qlik] connexion {host}:{port}"))?;
    let _ = tcp.set_nodelay(true);
    macro_rules! demarrer {
        ($io:expr) => {{
            let (sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new($io)).await?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Ok(sender)
        }};
    }
    if url.scheme() == "https" {
        let connector = tokio_rustls::TlsConnector::from(Arc::new(config_tls(cfg.tls_insecure)));
        let nom = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| anyhow!("[qlik] nom d'hôte invalide {host} : {e}"))?;
        let tls = connector.connect(nom, tcp).await.with_context(|| format!("[qlik] TLS {host}"))?;
        demarrer!(tls)
    } else {
        demarrer!(tcp)
    }
}

async fn envoyer(
    sender: &mut hyper::client::conn::http1::SendRequest<http_body_util::Empty<hyper::body::Bytes>>,
    url: &reqwest::Url,
    entetes: &[(&str, String)],
) -> anyhow::Result<ReponseNtlm> {
    use http_body_util::BodyExt;
    sender.ready().await?;
    let chemin = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    };
    let hote = match url.port() {
        Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    let mut req = hyper::Request::builder().method("GET").uri(chemin).header("Host", hote);
    for (k, v) in entetes {
        req = req.header(*k, v.as_str());
    }
    let res = sender.send_request(req.body(http_body_util::Empty::new())?).await?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    // Corps lu en entier : la connexion n'est réutilisable qu'ensuite.
    let _ = res.into_body().collect().await;
    Ok(ReponseNtlm { status, headers })
}

/// Équivalent de `httpntlm.get` : type 1 (keep-alive) → type 2 → type 3, sur
/// une seule connexion. Une redirection reçue en réponse au type 1 est suivie
/// (nouvelle négociation sur la nouvelle URL), comme dans `httpntlm`.
async fn ntlm_get(cfg: &QlikConfig, url: &str) -> anyhow::Result<ReponseNtlm> {
    let mut url = reqwest::Url::parse(url).with_context(|| format!("[qlik] URL invalide {url}"))?;
    let timeout = Duration::from_millis(cfg.timeout_ms);
    for _ in 0..10 {
        let mut sender =
            tokio::time::timeout(timeout, connexion_dediee(&url, cfg)).await.map_err(|_| anyhow!("[qlik] délai dépassé (connexion NTLM)"))??;
        // Type 1 : seuls Connection et Authorization (httpntlm ne transmet les
        // autres en-têtes qu'au dernier appel, où le serveur les consomme).
        let type1 = ntlm::create_type1_message(&cfg.domain, &cfg.workstation);
        let r1 = tokio::time::timeout(timeout, envoyer(&mut sender, &url, &[("Connection", "keep-alive".into()), ("Authorization", type1)]))
            .await
            .map_err(|_| anyhow!("[qlik] délai dépassé (NTLM type 1)"))??;
        if let Some(loc) = r1.headers.get("location").and_then(|v| v.to_str().ok()) {
            url = url.join(loc).with_context(|| format!("[qlik] redirection invalide {loc}"))?;
            continue;
        }
        let defis: Vec<String> = r1.headers.get_all("www-authenticate").iter().filter_map(|v| v.to_str().ok().map(String::from)).collect();
        if defis.is_empty() {
            bail!("www-authenticate not found on response of second request");
        }
        let defi = defis.iter().find(|d| d.contains("NTLM ")).cloned().unwrap_or_else(|| defis.join(", "));
        let msg2 = ntlm::parse_type2_message(&defi)?;
        let type3 = ntlm::create_type3_message(&msg2, &cfg.user, &cfg.password, &cfg.domain, &cfg.workstation);
        let entetes = [
            ("Connection", "Close".to_string()),
            ("Authorization", type3),
            ("User-Agent", "Mozilla/5.0 CollectFlow".to_string()),
            ("X-Qlik-Xrfkey", String::new()),
        ];
        return tokio::time::timeout(timeout, envoyer(&mut sender, &url, &entetes))
            .await
            .map_err(|_| anyhow!("[qlik] délai dépassé (NTLM type 3)"))?;
    }
    bail!("[qlik] trop de redirections pendant l'authentification NTLM")
}

fn extract_session_cookie(headers: &hyper::HeaderMap) -> Option<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or("").to_string())
        .find(|c| c.to_ascii_lowercase().contains("x-qlik-session"))
}

/// Client HTTP sans redirection automatique (`redirect: "manual"`).
fn client_manuel(cfg: &QlikConfig) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(cfg.tls_insecure)
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .build()?)
}

/// Ouvre une session Qlik : cookie `X-Qlik-Session` + xrfkey.
pub async fn qlik_ntlm_session(cfg: &QlikConfig) -> anyhow::Result<QlikSession> {
    if cfg.user.is_empty() || cfg.password.is_empty() {
        bail!("[qlik] QLIK_USER / QLIK_PWD manquants dans l'environnement");
    }
    let xrfkey = make_xrfkey();
    let http = client_manuel(cfg)?;

    // 1. targetId
    let hub = http.get(format!("https://{}/hub/", cfg.host)).send().await?;
    let loc1 = hub.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let target_id = regex::Regex::new(r"(?i)targetId=([0-9a-f-]+)").expect("regex").captures(&loc1).map(|c| c[1].to_string()).unwrap_or_default();

    // 2. NTLM -> ticket. Interne (réseau corp), /hub/ peut déjà renvoyer 401 NTLM
    //    et poser le cookie directement ; on gère les 2 cas.
    let win_path = if !target_id.is_empty() {
        format!("/internal_windows_authentication/?targetId={target_id}&xrfkey={xrfkey}")
    } else {
        format!("/hub/?xrfkey={xrfkey}")
    };
    let ntlm = ntlm_get(cfg, &format!("https://{}{win_path}", cfg.host)).await?;

    // Cookie posé directement (cas interne) ?
    if let Some(cookie) = extract_session_cookie(&ntlm.headers) {
        return Ok(QlikSession { cookie, xrfkey });
    }

    // 3. Échange ticket -> cookie
    let ticket_loc = ntlm.headers.get("location").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !ticket_loc.contains("qlikTicket=") {
        bail!("[qlik] Auth NTLM sans ticket (HTTP {}) — verifier mot de passe", ntlm.status);
    }
    let ticket_url = reqwest::Url::parse(&format!("https://{}/", cfg.host))?.join(&ticket_loc)?;
    let exch = http.get(ticket_url).send().await?;
    let cookie = exch
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|c| c.split(';').next().unwrap_or("").to_string())
        .filter(|c| c.to_ascii_lowercase().contains("x-qlik-session"))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() {
        bail!("[qlik] ticket non echange contre un cookie de session");
    }
    Ok(QlikSession { cookie, xrfkey })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xrfkey_16_alphanumeriques() {
        for _ in 0..50 {
            let k = make_xrfkey();
            assert_eq!(k.len(), 16);
            assert!(k.chars().all(|c| c.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn json_identique_au_ts() {
        let mut m =
            NetworkMetric { code_centrale: "10000167303".into(), ca_reseau: 1234.5, qte_reseau: 12.0, nb_magasins_reseau: 3.0, ..Default::default() };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(
            v.to_string(),
            r#"{"codeCentrale":"10000167303","caReseau":1234.5,"qteReseau":12,"nbMagasinsReseau":3,"caParMagasinReseau":0,"margePctReseau":0}"#
        );
        m.metrics_by_month = Some(BTreeMap::from([("2026-01".to_string(), QlikMonthMetrics { qte: 2.0, nb_mag: Some(1.0), ..Default::default() })]));
        m.qte_by_month = Some(BTreeMap::from([("2026-01".to_string(), 2.0)]));
        m.periode = Some("2025-02_2026-01".into());
        let texte = serde_json::to_string(&m).unwrap();
        assert!(texte.contains(r#""qteByMonth":{"2026-01":2}"#), "{texte}");
        assert!(texte.contains(r#""metricsByMonth":{"2026-01":{"qte":2,"nbMag":1}}"#), "{texte}");
        let relu: NetworkMetric = serde_json::from_str(&texte).unwrap();
        assert_eq!(relu.metrics_by_month, m.metrics_by_month);
    }

    /// Lit une requête HTTP/1.1 (en-têtes seuls, pas de corps en GET).
    async fn lire_requete(flux: &mut tokio::net::TcpStream) -> String {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut octet = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = flux.read(&mut octet).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&octet[..n]);
        }
        String::from_utf8_lossy(&buf).to_string()
    }

    /// Faux serveur NTLM : le type 3 DOIT arriver sur la connexion du type 1.
    #[tokio::test]
    async fn echange_ntlm_sur_une_seule_connexion() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let serveur = tokio::spawn(async move {
            let (mut c, _) = listener.accept().await.unwrap();
            let r1 = lire_requete(&mut c).await;
            assert!(r1.starts_with("GET /internal_windows_authentication/?targetId=abc HTTP/1.1"), "{r1}");
            assert!(r1.contains("authorization: NTLM TlRMTVNTUAABAAAAB6IIogAAAAAoAAAAAAAAACgAAAAFASgKAAAADw=="), "{r1}");
            assert!(!r1.to_lowercase().contains("user-agent"), "{r1}");
            let type2 = "TlRMTVNTUAACAAAADgAOADAAAAAVgoniASNFZ4mrze8AAAAAAAAAACQAJAA+AAAARABPAE0AQQBJAE4ARQACAA4ARABPAE0AQQBJAE4AAQAMAFMARQBSAFYARQBSAAAAAAA=";
            let rep = format!("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Negotiate\r\nWWW-Authenticate: NTLM {type2}\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nnon !");
            c.write_all(rep.as_bytes()).await.unwrap();
            let r2 = lire_requete(&mut c).await;
            assert!(r2.contains("authorization: NTLM TlRMTVNTUAADAAAA"), "{r2}");
            assert!(r2.contains("user-agent: Mozilla/5.0 CollectFlow"), "{r2}");
            assert!(r2.contains("x-qlik-xrfkey: \r\n"), "{r2}");
            assert!(r2.contains("connection: Close"), "{r2}");
            let rep = "HTTP/1.1 302 Found\r\nLocation: https://qlik.local/hub/?qlikTicket=TICKET\r\nSet-Cookie: X-Qlik-Session=s3ss10n; Path=/; HttpOnly\r\nContent-Length: 0\r\n\r\n";
            c.write_all(rep.as_bytes()).await.unwrap();
        });
        let mut cfg = get_qlik_config();
        cfg.user = "FFSCH".into();
        cfg.password = "Mot2Passe!".into();
        cfg.domain = String::new();
        cfg.workstation = String::new();
        let r = ntlm_get(&cfg, &format!("http://127.0.0.1:{port}/internal_windows_authentication/?targetId=abc")).await.unwrap();
        serveur.await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(r.headers.get("location").unwrap(), "https://qlik.local/hub/?qlikTicket=TICKET");
        assert_eq!(extract_session_cookie(&r.headers).as_deref(), Some("X-Qlik-Session=s3ss10n"));
    }
}
