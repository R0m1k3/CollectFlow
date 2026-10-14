//! Chromium et file d'attente partagés par tous les accès Qlik
//! (port de `src/lib/qlik-browser.ts`) — extraction réseau (`playwright.rs`),
//! recherche produit (`search.rs`).
//!
//! Le pilotage passe par le protocole DevTools (chromiumoxide) ; [`PageQlik`]
//! regroupe l'équivalent des fonctions Playwright utilisées par le TS :
//! contexte isolé (`browser.newContext`), `ctx.addCookies`, `httpCredentials`,
//! `page.on("console" | "pageerror" | "websocket")`, `page.exposeFunction`,
//! `page.goto(…, domcontentloaded)` et `page.evaluate(fn, args)`.

use anyhow::{anyhow, Context};
use chromiumoxide::browser::BrowserConfig;
use chromiumoxide::cdp::browser_protocol::browser::BrowserContextId;
use chromiumoxide::cdp::browser_protocol::network::{CookieParam, EventWebSocketCreated, SetCookiesParams};
use chromiumoxide::cdp::browser_protocol::page::{AddScriptToEvaluateOnNewDocumentParams, EventDomContentEventFired, NavigateParams};
use chromiumoxide::cdp::browser_protocol::target::{CreateBrowserContextParams, CreateTargetParams};
use chromiumoxide::cdp::js_protocol::runtime::{
    AddBindingParams, EvaluateParams, EventBindingCalled, EventConsoleApiCalled, EventExceptionThrown, RemoteObject,
};
use chromiumoxide::{Browser, Page};
use futures::StreamExt;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::JoinHandle;

// ---------------------------------------------------------------------------
// Chromium partagé
// ---------------------------------------------------------------------------

struct Navigateur {
    browser: Arc<Browser>,
    connecte: Arc<AtomicBool>,
}

static NAVIGATEUR: LazyLock<Mutex<Option<Navigateur>>> = LazyLock::new(|| Mutex::new(None));
static LANCEMENTS: AtomicUsize = AtomicUsize::new(0);

/// Recherche un exécutable dans le PATH.
fn dans_le_path(nom: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(nom)).find(|p| p.is_file())
}

/// Exécutable Chromium : `PLAYWRIGHT_CHROMIUM_PATH`, puis `CHROMIUM_PATH`, puis
/// `chromium` / `chromium-browser` dans le PATH ; à défaut, détection de chromiumoxide.
pub fn chemin_chromium() -> Option<PathBuf> {
    for var in ["PLAYWRIGHT_CHROMIUM_PATH", "CHROMIUM_PATH"] {
        if let Some(p) = std::env::var(var).ok().filter(|v| !v.trim().is_empty()) {
            return Some(PathBuf::from(p));
        }
    }
    ["chromium", "chromium-browser"].into_iter().find_map(dans_le_path)
}

async fn lancer() -> anyhow::Result<Navigateur> {
    let n = LANCEMENTS.fetch_add(1, Ordering::SeqCst);
    // Profil propre à chaque lancement : un Chromium tombé laisse son verrou
    // (SingletonLock) dans le profil et empêcherait la relance.
    let profil = std::env::temp_dir().join(format!("collectflow-chromium-{}-{n}", std::process::id()));
    let mut builder = BrowserConfig::builder()
        .no_sandbox()
        .arg("disable-dev-shm-usage")
        .arg("ignore-certificate-errors")
        .user_data_dir(&profil)
        .launch_timeout(Duration::from_secs(60))
        // Délai des commandes passées par le gestionnaire du navigateur. Il ne
        // couvre PAS les commandes de page, coupées à 30 s par chromiumoxide :
        // les scripts longs passent donc par `PageQlik::evaluer`, qui n'attend
        // jamais une commande plus de quelques instants.
        .request_timeout(Duration::from_secs(24 * 3600));
    if let Some(chemin) = chemin_chromium() {
        builder = builder.chrome_executable(chemin);
    }
    let config = builder.build().map_err(|e| anyhow!("[qlik] configuration Chromium : {e}"))?;
    let (browser, mut handler) = Browser::launch(config).await.context("[qlik] lancement de Chromium")?;
    let connecte = Arc::new(AtomicBool::new(true));
    let drapeau = connecte.clone();
    tokio::spawn(async move {
        // Le gestionnaire CDP doit être consommé en continu ; sa fin = navigateur
        // déconnecté (plantage, mémoire, arrêt du processus enfant).
        while let Some(evt) = handler.next().await {
            if let Err(e) = evt {
                tracing::debug!("[qlik] événement CDP ignoré : {e}");
            }
        }
        drapeau.store(false, Ordering::SeqCst);
        tracing::warn!("[qlik] Chromium déconnecté — il sera relancé à la prochaine extraction");
        let _ = std::fs::remove_dir_all(&profil);
    });
    Ok(Navigateur { browser: Arc::new(browser), connecte })
}

/// Chromium partagé entre les extractions.
///
/// Un navigateur tombé (plantage, mémoire, arrêt du processus enfant) restait
/// mémorisé : toutes les extractions suivantes échouaient sur « Target closed »
/// jusqu'au redémarrage du serveur. On le relance donc dès qu'il est déconnecté.
pub async fn get_qlik_browser() -> anyhow::Result<Arc<Browser>> {
    let mut garde = NAVIGATEUR.lock().await;
    if let Some(n) = garde.as_ref() {
        if n.connecte.load(Ordering::SeqCst) {
            return Ok(n.browser.clone());
        }
    }
    if let Some(ancien) = garde.take() {
        if let Ok(mut b) = Arc::try_unwrap(ancien.browser) {
            let _ = b.kill().await;
        }
    }
    let n = lancer().await?;
    let b = n.browser.clone();
    *garde = Some(n);
    Ok(b)
}

/// Tests : pilote un Chromium déjà lancé (`--remote-debugging-port`), par
/// exemple celui de l'image Docker de production, au lieu d'en lancer un.
#[cfg(test)]
pub async fn utiliser_chromium_distant(url: &str) -> anyhow::Result<()> {
    let (browser, mut handler) = Browser::connect(url).await.context("[qlik] connexion au Chromium distant")?;
    let connecte = Arc::new(AtomicBool::new(true));
    let drapeau = connecte.clone();
    tokio::spawn(async move {
        while handler.next().await.is_some() {}
        drapeau.store(false, Ordering::SeqCst);
    });
    *NAVIGATEUR.lock().await = Some(Navigateur { browser: Arc::new(browser), connecte });
    Ok(())
}

// ---------------------------------------------------------------------------
// File unique des extractions
// ---------------------------------------------------------------------------

/// Le serveur Qlik abandonne les requêtes dès qu'il est trop sollicité. Une
/// synchro manuelle lancée pendant la synchro de nuit, ou deux recherches
/// produit simultanées, ouvraient deux sessions Engine en parallèle — et les
/// deux échouaient. Les extractions passent désormais l'une après l'autre
/// (le verrou tokio est équitable : premier arrivé, premier servi).
static FILE_EXTRACTIONS: Mutex<()> = Mutex::const_new(());
static EXTRACTIONS_EN_ATTENTE: AtomicUsize = AtomicUsize::new(0);

struct DecompteFile;

impl Drop for DecompteFile {
    fn drop(&mut self) {
        EXTRACTIONS_EN_ATTENTE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Exécute `tache` quand toutes les extractions Qlik précédentes sont terminées.
pub async fn dans_la_file_qlik<T, F>(libelle: &str, tache: impl FnOnce() -> F) -> T
where
    F: std::future::Future<Output = T>,
{
    let en_attente = EXTRACTIONS_EN_ATTENTE.fetch_add(1, Ordering::SeqCst);
    let _decompte = DecompteFile;
    if en_attente > 0 {
        tracing::info!("[qlik] {libelle} : en attente de {en_attente} extraction(s) en cours");
    }
    let _tour = FILE_EXTRACTIONS.lock().await;
    tache().await
}

// ---------------------------------------------------------------------------
// Page Qlik (contexte isolé + équivalents Playwright)
// ---------------------------------------------------------------------------

/// Filtre/format d'une ligne de console de la page : `None` = ignorée.
pub type FiltreConsole = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Page Chromium dans un contexte de navigation isolé (≈ `browser.newContext()`).
pub struct PageQlik {
    browser: Arc<Browser>,
    contexte: Option<BrowserContextId>,
    pub page: Page,
    taches: Vec<JoinHandle<()>>,
}

/// Texte d'un argument de console, comme `msg.text()` de Playwright.
fn texte_remote(o: &RemoteObject) -> String {
    match &o.value {
        Some(Value::String(s)) => s.clone(),
        Some(v) if !v.is_null() => v.to_string(),
        _ => o
            .unserializable_value
            .as_ref()
            .map(|u| u.inner().to_string())
            .or_else(|| o.description.clone())
            .unwrap_or_else(|| format!("JSHandle@{:?}", o.r#type).to_lowercase()),
    }
}

impl PageQlik {
    /// Ouvre une page vierge dans un nouveau contexte isolé et branche la
    /// console (`filtre_console`) et les erreurs de page (`prefixe_erreur`).
    pub async fn ouvrir(browser: Arc<Browser>, filtre_console: FiltreConsole, prefixe_erreur: Option<&'static str>) -> anyhow::Result<Self> {
        let contexte = browser.create_browser_context(CreateBrowserContextParams::default()).await.context("[qlik] création du contexte Chromium")?;
        let params = CreateTargetParams::builder()
            .url("about:blank")
            .browser_context_id(contexte.clone())
            .build()
            .map_err(|e| anyhow!("[qlik] paramètres de page : {e}"))?;
        let page = match tokio::time::timeout(Duration::from_secs(60), browser.new_page(params)).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) => {
                let _ = browser.dispose_browser_context(contexte).await;
                return Err(anyhow!("[qlik] ouverture de page : {e}"));
            }
            Err(_) => {
                let _ = browser.dispose_browser_context(contexte).await;
                return Err(anyhow!("[qlik] ouverture de page : délai dépassé"));
            }
        };
        let mut moi = Self { browser, contexte: Some(contexte), page, taches: Vec::new() };

        let mut console = moi.page.event_listener::<EventConsoleApiCalled>().await?;
        moi.taches.push(tokio::spawn(async move {
            while let Some(evt) = console.next().await {
                let texte = evt.args.iter().map(texte_remote).collect::<Vec<_>>().join(" ");
                if let Some(ligne) = filtre_console(&texte) {
                    tracing::info!("{ligne}");
                }
            }
        }));
        if let Some(prefixe) = prefixe_erreur {
            let mut erreurs = moi.page.event_listener::<EventExceptionThrown>().await?;
            moi.taches.push(tokio::spawn(async move {
                while let Some(evt) = erreurs.next().await {
                    let d = &evt.exception_details;
                    let message = d.exception.as_ref().and_then(|e| e.description.clone()).unwrap_or_else(|| d.text.clone());
                    tracing::info!("{prefixe} {message}");
                }
            }));
        }
        Ok(moi)
    }

    /// `ctx.addCookies([{ name, value, domain, path: "/", secure: true }])`.
    pub async fn ajouter_cookie(&self, nom: &str, valeur: &str, domaine: &str) -> anyhow::Result<()> {
        let cookie = CookieParam::builder()
            .name(nom)
            .value(valeur)
            .domain(domaine)
            .path("/")
            .secure(true)
            .build()
            .map_err(|e| anyhow!("[qlik] cookie invalide : {e}"))?;
        self.page.execute(SetCookiesParams::new(vec![cookie])).await.context("[qlik] Network.setCookies")?;
        Ok(())
    }

    /// `httpCredentials` : identifiants fournis aux défis HTTP (NTLM / Basic)
    /// que le navigateur rencontre.
    pub async fn identifiants_http(&self, user: &str, password: &str) -> anyhow::Result<()> {
        self.page.authenticate(chromiumoxide::auth::Credentials { username: user.to_string(), password: password.to_string() }).await?;
        Ok(())
    }

    /// Surveille les websockets ouverts par la page (`page.on("websocket")`) et
    /// publie la première valeur de `qlik-csrf-token` trouvée dans leur URL.
    pub async fn capturer_jeton_csrf(&mut self) -> anyhow::Result<watch::Receiver<Option<String>>> {
        let (tx, rx) = watch::channel(None);
        let mut ws = self.page.event_listener::<EventWebSocketCreated>().await?;
        let re = regex::Regex::new(r"qlik-csrf-token=([^&]+)").expect("regex");
        self.taches.push(tokio::spawn(async move {
            while let Some(evt) = ws.next().await {
                if tx.borrow().is_some() {
                    continue;
                }
                if let Some(c) = re.captures(&evt.url) {
                    let jeton = urlencoding::decode(&c[1]).map(|s| s.into_owned()).unwrap_or_else(|_| c[1].to_string());
                    let _ = tx.send(Some(jeton));
                }
            }
        }));
        Ok(rx)
    }

    /// `page.exposeFunction(nom, …)` : `window[nom](payload)` transmet
    /// `JSON.stringify(payload)` côté Rust (canal renvoyé) et se résout à `true`.
    pub async fn exposer_fonction(&mut self, nom: &str) -> anyhow::Result<mpsc::UnboundedReceiver<String>> {
        let liaison = format!("__cf_binding_{nom}");
        let (tx, rx) = mpsc::unbounded_channel();
        let mut appels = self.page.event_listener::<EventBindingCalled>().await?;
        let attendu = liaison.clone();
        self.taches.push(tokio::spawn(async move {
            while let Some(evt) = appels.next().await {
                if evt.name == attendu {
                    let _ = tx.send(evt.payload.clone());
                }
            }
        }));
        self.page.execute(AddBindingParams::new(liaison.clone())).await.context("[qlik] Runtime.addBinding")?;
        let nom_js = serde_json::to_string(nom)?;
        let liaison_js = serde_json::to_string(&liaison)?;
        let shim = format!(
            "(() => {{ const n = {nom_js}, b = {liaison_js}; window[n] = (p) => {{ const f = window[b]; \
             if (typeof f !== 'function') return Promise.reject(new Error('liaison ' + b + ' absente')); \
             f(JSON.stringify(p === undefined ? null : p)); return Promise.resolve(true); }}; }})()"
        );
        // Documents futurs (navigations) puis document courant.
        self.page.execute(AddScriptToEvaluateOnNewDocumentParams::new(shim.clone())).await?;
        let _ = self.page.execute(EvaluateParams::new(shim)).await;
        Ok(rx)
    }

    /// `page.goto(url, { waitUntil: "domcontentloaded", timeout })`.
    pub async fn aller(&self, url: &str, timeout: Duration) -> anyhow::Result<()> {
        let mut dcl = self.page.event_listener::<EventDomContentEventFired>().await?;
        let navigation = async {
            let res = self.page.execute(NavigateParams::new(url)).await.context("[qlik] Page.navigate")?;
            if let Some(err) = res.result.error_text.as_ref().filter(|e| !e.is_empty()) {
                return Err(anyhow!("[qlik] navigation {url} : {err}"));
            }
            dcl.next().await;
            Ok(())
        };
        tokio::time::timeout(timeout, navigation)
            .await
            .map_err(|_| anyhow!("[qlik] navigation {url} : délai de {} ms dépassé", timeout.as_millis()))?
    }

    /// `page.evaluate(fn, args)` : `source` est le texte d'une fonction JS
    /// (éventuellement async), appelée avec `args` ; la promesse est attendue et
    /// le résultat rendu en JSON (`JSON.stringify` côté page, donc NaN → null).
    ///
    /// ⚠️ chromiumoxide coupe toute commande de page au bout de 30 s, en dur
    /// (`REQUEST_TIMEOUT` de `CommandFuture`, insensible à `request_timeout`).
    /// Une extraction Qlik dure plusieurs minutes : l'attendre dans un seul
    /// `Runtime.evaluate` la faisait échouer sur « Request timed out ». Le
    /// script est donc lancé sans être attendu, et son résultat relevé par des
    /// évaluations courtes jusqu'à ce qu'il soit prêt.
    pub async fn evaluer(&self, source: &str, args: &Value) -> anyhow::Result<Value> {
        static TRAVAUX: AtomicUsize = AtomicUsize::new(0);
        let cle = serde_json::to_string(&format!("__cf_eval_{}", TRAVAUX.fetch_add(1, Ordering::SeqCst)))?;
        let lancement = format!(
            "(() => {{ const __e = window[{cle}] = {{ fini: false }}; \
             Promise.resolve().then(() => (\n{source}\n)({})).then( \
               (r) => {{ __e.json = JSON.stringify(r === undefined ? null : r); __e.fini = true; }}, \
               (e) => {{ __e.erreur = String((e && e.stack) || e); __e.fini = true; }}); \
             return true; }})()",
            serde_json::to_string(args)?
        );
        self.evaluer_court(lancement).await?;

        let releve = format!(
            "(() => {{ const __e = window[{cle}]; if (!__e) return {{ absent: true }}; if (!__e.fini) return null; \
             delete window[{cle}]; return __e.erreur !== undefined ? {{ erreur: __e.erreur }} : {{ json: __e.json }}; }})()"
        );
        let mut pause = Duration::from_millis(20);
        loop {
            tokio::time::sleep(pause).await;
            pause = (pause * 2).min(Duration::from_secs(1));
            let etat = self.evaluer_court(releve.clone()).await?;
            if etat.is_null() {
                continue;
            }
            if etat.get("absent").is_some() {
                // La page a été rechargée : le script et son état ont disparu.
                return Err(anyhow!("Execution context was destroyed (page rechargée pendant l'évaluation)"));
            }
            if let Some(erreur) = etat.get("erreur").and_then(|e| e.as_str()) {
                return Err(anyhow!("{erreur}"));
            }
            return match etat.get("json").and_then(|j| j.as_str()) {
                Some(s) => Ok(serde_json::from_str(s)?),
                None => Ok(Value::Null),
            };
        }
    }

    /// `Runtime.evaluate` d'une expression synchrone, résultat par valeur.
    /// Doit rester bien en deçà des 30 s de chromiumoxide (cf. [`Self::evaluer`]).
    async fn evaluer_court(&self, expression: String) -> anyhow::Result<Value> {
        let params = EvaluateParams::builder()
            .expression(expression)
            .return_by_value(true)
            .build()
            .map_err(|e| anyhow!("[qlik] paramètres d'évaluation : {e}"))?;
        let res = self.page.execute(params).await.map_err(|e| anyhow!("{e}"))?;
        if let Some(ex) = res.result.exception_details.as_ref() {
            let message = ex.exception.as_ref().and_then(|e| e.description.clone()).unwrap_or_else(|| ex.text.clone());
            return Err(anyhow!("{message}"));
        }
        Ok(res.result.result.value.clone().unwrap_or(Value::Null))
    }

    /// Ferme la page puis le contexte (`ctx.close()`).
    pub async fn fermer(mut self) {
        for t in self.taches.drain(..) {
            t.abort();
        }
        let _ = tokio::time::timeout(Duration::from_secs(10), self.page.clone().close()).await;
        if let Some(c) = self.contexte.take() {
            let _ = tokio::time::timeout(Duration::from_secs(10), self.browser.dispose_browser_context(c)).await;
        }
    }
}

impl Drop for PageQlik {
    fn drop(&mut self) {
        for t in self.taches.drain(..) {
            t.abort();
        }
    }
}
