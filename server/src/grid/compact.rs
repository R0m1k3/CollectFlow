//! Dictionnaire compact des séries de la Grille (mois → valeur, magasin → série).
//!
//! Les lignes de grille portaient une dizaine de `BTreeMap<String, f64>` (ventes,
//! stock, réceptions sur 12 mois, par magasin, réseau) : chaque clé (`"202601"`,
//! `"292"`) était une allocation à part et chaque arbre réservait des nœuds de
//! 11 entrées. Mesuré : ~22 Ko par ligne en mémoire pour 2,6 Ko de JSON, soit
//! plusieurs Go pour un cache de 150 000 lignes.
//!
//! [`CompactMap`] garde le même comportement observable qu'un `BTreeMap` (clés
//! uniques triées dans l'ordre des chaînes, donc JSON identique) dans un seul
//! vecteur trié, avec des clés courtes stockées en place ([`Cle`], 16 octets, sans
//! allocation jusqu'à 15 octets).

use parking_lot::RwLock;
use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};
use std::borrow::Borrow;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fmt;
use std::sync::LazyLock;

const INLINE: usize = 15;
/// Marqueur de longueur : clé longue, `buf[..4]` = index dans [`LONGUES`].
const LONGUE: u8 = u8::MAX;

/// Clés de plus de 15 octets (rares : mois et codes magasin sont courts),
/// conservées une fois pour toutes.
static LONGUES: LazyLock<RwLock<(Vec<&'static str>, HashMap<&'static str, u32>)>> =
    LazyLock::new(|| RwLock::new((Vec::new(), HashMap::new())));

/// Clé de 16 octets : chaîne en place jusqu'à 15 octets, sinon index d'une chaîne
/// conservée. Se compare, se hache et se sérialise comme la chaîne.
#[derive(Clone, Copy)]
pub struct Cle {
    len: u8,
    buf: [u8; INLINE],
}

impl Cle {
    pub fn new(s: &str) -> Self {
        let mut buf = [0u8; INLINE];
        if s.len() <= INLINE {
            buf[..s.len()].copy_from_slice(s.as_bytes());
            return Cle { len: s.len() as u8, buf };
        }
        // Lecture d'abord (verrou relâché avant l'écriture : il n'est pas réentrant).
        let deja = LONGUES.read().1.get(s).copied();
        let index = match deja {
            Some(i) => i,
            None => {
                let mut l = LONGUES.write();
                match l.1.get(s) {
                    Some(i) => *i,
                    None => {
                        let fixe: &'static str = Box::leak(s.to_string().into_boxed_str());
                        let i = l.0.len() as u32;
                        l.0.push(fixe);
                        l.1.insert(fixe, i);
                        i
                    }
                }
            }
        };
        buf[..4].copy_from_slice(&index.to_le_bytes());
        Cle { len: LONGUE, buf }
    }

    pub fn as_str(&self) -> &str {
        if self.len == LONGUE {
            let i = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            return LONGUES.read().0[i];
        }
        // SAFETY : `buf[..len]` est une copie d'une `&str` (UTF-8 valide).
        unsafe { std::str::from_utf8_unchecked(&self.buf[..self.len as usize]) }
    }
}

impl std::ops::Deref for Cle {
    type Target = str;
    fn deref(&self) -> &str {
        self.as_str()
    }
}
impl AsRef<str> for Cle {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}
impl Borrow<str> for Cle {
    fn borrow(&self) -> &str {
        self.as_str()
    }
}
impl From<&str> for Cle {
    fn from(s: &str) -> Self {
        Cle::new(s)
    }
}
impl From<&String> for Cle {
    fn from(s: &String) -> Self {
        Cle::new(s)
    }
}
impl From<String> for Cle {
    fn from(s: String) -> Self {
        Cle::new(&s)
    }
}
impl From<&Cle> for Cle {
    fn from(c: &Cle) -> Self {
        *c
    }
}
impl From<Cle> for String {
    fn from(c: Cle) -> Self {
        c.as_str().to_string()
    }
}
impl PartialEq for Cle {
    fn eq(&self, o: &Self) -> bool {
        self.as_str() == o.as_str()
    }
}
impl Eq for Cle {}
impl PartialEq<str> for Cle {
    fn eq(&self, o: &str) -> bool {
        self.as_str() == o
    }
}
impl PartialEq<&str> for Cle {
    fn eq(&self, o: &&str) -> bool {
        self.as_str() == *o
    }
}
impl PartialEq<String> for Cle {
    fn eq(&self, o: &String) -> bool {
        self.as_str() == o.as_str()
    }
}
impl PartialOrd for Cle {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Cle {
    fn cmp(&self, o: &Self) -> Ordering {
        self.as_str().cmp(o.as_str())
    }
}
impl std::hash::Hash for Cle {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        self.as_str().hash(h)
    }
}
impl fmt::Debug for Cle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}
impl fmt::Display for Cle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl Serialize for Cle {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for Cle {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Cle;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("une chaîne")
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<Cle, E> {
                Ok(Cle::new(s))
            }
        }
        d.deserialize_str(V)
    }
}

/// Dictionnaire trié par clé, dans un seul vecteur (cf. module).
#[derive(Clone, PartialEq)]
pub struct CompactMap<V> {
    v: Vec<(Cle, V)>,
}

impl<V> Default for CompactMap<V> {
    fn default() -> Self {
        CompactMap { v: Vec::new() }
    }
}

impl<V: fmt::Debug> fmt::Debug for CompactMap<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_map().entries(self.v.iter().map(|(k, v)| (k, v))).finish()
    }
}

/// Entrée de [`CompactMap::entry`] (sous-ensemble de `btree_map::Entry`).
pub struct Entree<'a, V> {
    map: &'a mut CompactMap<V>,
    pos: Result<usize, usize>,
    cle: Cle,
}

impl<'a, V> Entree<'a, V> {
    pub fn or_insert_with(self, f: impl FnOnce() -> V) -> &'a mut V {
        let i = match self.pos {
            Ok(i) => i,
            Err(i) => {
                self.map.v.insert(i, (self.cle, f()));
                i
            }
        };
        &mut self.map.v[i].1
    }
    pub fn or_insert(self, v: V) -> &'a mut V {
        self.or_insert_with(|| v)
    }
    pub fn or_default(self) -> &'a mut V
    where
        V: Default,
    {
        self.or_insert_with(V::default)
    }
    pub fn and_modify(self, f: impl FnOnce(&mut V)) -> Self {
        if let Ok(i) = self.pos {
            f(&mut self.map.v[i].1);
        }
        self
    }
}

impl<V> CompactMap<V> {
    pub fn new() -> Self {
        Self::default()
    }
    fn chercher(&self, k: &str) -> Result<usize, usize> {
        self.v.binary_search_by(|(c, _)| c.as_str().cmp(k))
    }
    pub fn len(&self) -> usize {
        self.v.len()
    }
    pub fn is_empty(&self) -> bool {
        self.v.is_empty()
    }
    pub fn get<Q: AsRef<str> + ?Sized>(&self, k: &Q) -> Option<&V> {
        self.chercher(k.as_ref()).ok().map(|i| &self.v[i].1)
    }
    pub fn get_mut<Q: AsRef<str> + ?Sized>(&mut self, k: &Q) -> Option<&mut V> {
        self.chercher(k.as_ref()).ok().map(move |i| &mut self.v[i].1)
    }
    pub fn contains_key<Q: AsRef<str> + ?Sized>(&self, k: &Q) -> bool {
        self.chercher(k.as_ref()).is_ok()
    }
    pub fn insert(&mut self, k: impl Into<Cle>, val: V) -> Option<V> {
        let k = k.into();
        match self.chercher(k.as_str()) {
            Ok(i) => Some(std::mem::replace(&mut self.v[i].1, val)),
            Err(i) => {
                self.v.insert(i, (k, val));
                None
            }
        }
    }
    pub fn remove<Q: AsRef<str> + ?Sized>(&mut self, k: &Q) -> Option<V> {
        self.chercher(k.as_ref()).ok().map(|i| self.v.remove(i).1)
    }
    pub fn entry(&mut self, k: impl Into<Cle>) -> Entree<'_, V> {
        let cle = k.into();
        let pos = self.chercher(cle.as_str());
        Entree { map: self, pos, cle }
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = (&Cle, &V)> + ExactSizeIterator + Clone {
        self.v.iter().map(|(k, v)| (k, v))
    }
    pub fn iter_mut(&mut self) -> impl DoubleEndedIterator<Item = (&Cle, &mut V)> + ExactSizeIterator {
        self.v.iter_mut().map(|(k, v)| (&*k, v))
    }
    pub fn keys(&self) -> impl DoubleEndedIterator<Item = &Cle> + ExactSizeIterator + Clone {
        self.v.iter().map(|(k, _)| k)
    }
    pub fn values(&self) -> impl DoubleEndedIterator<Item = &V> + ExactSizeIterator + Clone {
        self.v.iter().map(|(_, v)| v)
    }
    pub fn values_mut(&mut self) -> impl DoubleEndedIterator<Item = &mut V> + ExactSizeIterator {
        self.v.iter_mut().map(|(_, v)| v)
    }
    pub fn retain(&mut self, mut f: impl FnMut(&Cle, &mut V) -> bool) {
        self.v.retain_mut(|(k, v)| f(k, v));
    }
    pub fn first_key_value(&self) -> Option<(&Cle, &V)> {
        self.v.first().map(|(k, v)| (k, v))
    }
    pub fn last_key_value(&self) -> Option<(&Cle, &V)> {
        self.v.last().map(|(k, v)| (k, v))
    }
    pub fn clear(&mut self) {
        self.v.clear();
    }
    /// Libère la capacité en trop (après construction).
    pub fn shrink_to_fit(&mut self) {
        self.v.shrink_to_fit();
    }
    /// Conversion des valeurs (même ordre, mêmes clés).
    pub fn map_values<W>(self, mut f: impl FnMut(V) -> W) -> CompactMap<W> {
        CompactMap { v: self.v.into_iter().map(|(k, v)| (k, f(v))).collect() }
    }

    /// Trie et dédoublonne (la dernière valeur d'une clé l'emporte, comme les
    /// insertions successives dans un `BTreeMap`).
    fn depuis_vec(mut v: Vec<(Cle, V)>) -> Self {
        let deja_trie = v.windows(2).all(|w| w[0].0 < w[1].0);
        if !deja_trie {
            // Tri stable : à clé égale, l'ordre d'arrivée est conservé.
            v.sort_by(|a, b| a.0.cmp(&b.0));
            let mut sortie: Vec<(Cle, V)> = Vec::with_capacity(v.len());
            for (k, val) in v {
                match sortie.last_mut() {
                    Some(dernier) if dernier.0 == k => dernier.1 = val,
                    _ => sortie.push((k, val)),
                }
            }
            v = sortie;
        }
        v.shrink_to_fit();
        CompactMap { v }
    }
}

impl<K: Into<Cle>, V> FromIterator<(K, V)> for CompactMap<V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(it: I) -> Self {
        Self::depuis_vec(it.into_iter().map(|(k, v)| (k.into(), v)).collect())
    }
}

impl<K: Into<Cle>, V> From<std::collections::BTreeMap<K, V>> for CompactMap<V> {
    fn from(m: std::collections::BTreeMap<K, V>) -> Self {
        // Déjà trié et sans doublon : pas de tri à refaire.
        let mut v: Vec<(Cle, V)> = m.into_iter().map(|(k, v)| (k.into(), v)).collect();
        v.shrink_to_fit();
        CompactMap { v }
    }
}

/// Ventilation magasin → mois construite en `BTreeMap` pendant le calcul.
pub fn par_magasin(m: std::collections::BTreeMap<String, std::collections::BTreeMap<String, f64>>) -> CompactMap<CompactMap<f64>> {
    m.into_iter().map(|(k, v)| (k, CompactMap::from(v))).collect()
}

impl<K: Into<Cle>, V> Extend<(K, V)> for CompactMap<V> {
    fn extend<I: IntoIterator<Item = (K, V)>>(&mut self, it: I) {
        for (k, v) in it {
            self.insert(k, v);
        }
    }
}

impl<'a, V> IntoIterator for &'a CompactMap<V> {
    type Item = (&'a Cle, &'a V);
    type IntoIter = std::iter::Map<std::slice::Iter<'a, (Cle, V)>, fn(&'a (Cle, V)) -> (&'a Cle, &'a V)>;
    fn into_iter(self) -> Self::IntoIter {
        self.v.iter().map(|(k, v)| (k, v))
    }
}

impl<V> IntoIterator for CompactMap<V> {
    type Item = (Cle, V);
    type IntoIter = std::vec::IntoIter<(Cle, V)>;
    fn into_iter(self) -> Self::IntoIter {
        self.v.into_iter()
    }
}

impl<V, Q: AsRef<str> + ?Sized> std::ops::Index<&Q> for CompactMap<V> {
    type Output = V;
    fn index(&self, k: &Q) -> &V {
        self.get(k).expect("clé absente")
    }
}

impl<V: Serialize> Serialize for CompactMap<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.v.len()))?;
        for (k, v) in &self.v {
            m.serialize_entry(k.as_str(), v)?;
        }
        m.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for CompactMap<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Vis<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for Vis<V> {
            type Value = CompactMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("un objet")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut v = Vec::with_capacity(a.size_hint().unwrap_or(0).min(64));
                while let Some((k, val)) = a.next_entry::<Cle, V>()? {
                    v.push((k, val));
                }
                Ok(CompactMap::depuis_vec(v))
            }
        }
        d.deserialize_map(Vis(std::marker::PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn meme_comportement_qu_un_btreemap() {
        let cles = ["202612", "2026-01", "292", "29", "", "une clé nettement plus longue que quinze", "579", "202601", "292"];
        let mut a: BTreeMap<String, f64> = BTreeMap::new();
        let mut b: CompactMap<f64> = CompactMap::new();
        for (i, k) in cles.iter().enumerate() {
            assert_eq!(a.insert(k.to_string(), i as f64), b.insert(*k, i as f64));
        }
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
        assert_eq!(a.len(), b.len());
        for k in cles {
            assert_eq!(a.get(k), b.get(k));
        }
        *b.entry("292").or_insert(0.0) += 1.0;
        *a.entry("292".to_string()).or_insert(0.0) += 1.0;
        assert_eq!(a.get("292"), b.get("292"));
        // Relecture : doublons → la dernière valeur, ordre trié.
        let relu: CompactMap<f64> = serde_json::from_str(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        let reference: BTreeMap<String, f64> = serde_json::from_str(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        assert_eq!(serde_json::to_string(&relu).unwrap(), serde_json::to_string(&reference).unwrap());
        let collecte: CompactMap<f64> = vec![("z", 1.0), ("a", 2.0), ("z", 3.0)].into_iter().collect();
        let collecte_ref: BTreeMap<&str, f64> = vec![("z", 1.0), ("a", 2.0), ("z", 3.0)].into_iter().collect();
        assert_eq!(serde_json::to_string(&collecte).unwrap(), serde_json::to_string(&collecte_ref).unwrap());
        assert_eq!(std::mem::size_of::<Cle>(), 16);
    }
}
