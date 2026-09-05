use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// The only bangumi-data item type kept in the offline map. bangumi-data stores
// `type` as a string ("tv" | "movie" | "ova" | "web"); the contract's "type==2
// (动漫)" corresponds to TV anime, so we retain only "tv" entries. This matches
// the previous map's effective scope (TV series dominate the embedded data) and
// keeps the generated map well under the 3 MB budget without expanding it.
const KEPT_TYPE: &str = "tv";

fn site_id(item: &Value, site_name: &str) -> Option<String> {
    item["sites"]
        .as_array()?
        .iter()
        .find(|site| site["site"].as_str() == Some(site_name))?["id"]
        .as_str()
        .map(str::to_string)
}

fn first_translation(item: &Value, language: &str) -> Option<String> {
    item["titleTranslate"][language]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find(|title| !title.trim().is_empty())
        .map(str::to_string)
}

// The ISO date anchor encoded inside an RFC 5545-style recurrence string,
// e.g. "R/2024-01-01T00:00:00.000Z/P7D" -> "2024-01-01T00:00:00.000Z".
fn broadcast_anchor(broadcast: &str) -> Option<&str> {
    broadcast.get(2..)?.split('/').next().filter(|value| !value.is_empty())
}

// Keep the site entries that carry a begin or a broadcast schedule, truncated
// to the first 8 in source order. A value the subject can already derive (it
// equals the subject-level begin/broadcast, or the begin is simply the anchor
// inside its own broadcast) is stored as null so the schedule stays lossless
// under the size budget. A site with no distinct schedule after this reduction
// is dropped entirely.
fn qualifying_sites(item: &Value) -> Vec<Value> {
    let item_begin = item["begin"].as_str().filter(|value| !value.is_empty());
    let item_broadcast = item["broadcast"].as_str().filter(|value| !value.is_empty());
    let mut sites = Vec::new();
    for site in item["sites"].as_array().into_iter().flatten() {
        let site_begin = site["begin"].as_str().filter(|value| !value.is_empty());
        let site_broadcast = site["broadcast"].as_str().filter(|value| !value.is_empty());
        if site_begin.is_none() && site_broadcast.is_none() {
            continue;
        }
        let (Some(site_name), Some(site_raw_id)) =
            (site["site"].as_str(), site["id"].as_str())
        else {
            continue;
        };
        let mut begin = site_begin;
        if begin == item_begin {
            begin = None;
        }
        if begin.is_some() && begin == site_broadcast.and_then(broadcast_anchor) {
            begin = None;
        }
        let broadcast = site_broadcast.filter(|value| Some(*value) != item_broadcast);
        if begin.is_none() && broadcast.is_none() {
            continue;
        }
        sites.push(json!({
            "s": site_name,
            "i": site_raw_id,
            "begin": begin,
            "broadcast": broadcast,
        }));
        if sites.len() >= 8 {
            break;
        }
    }
    sites
}

// Build the v2 offline map: `{ version, bySubject, anilistIndex }`.
//
// * bySubject is keyed by the Bangumi subject id string and holds the subject
//   schedule metadata (item-level begin/broadcast plus the qualifying site
//   entries).
// * anilistIndex maps an AniList id string to a representative subject id
//   number; the runtime matcher recovers every candidate for an anilist id by
//   scanning bySubject on the `a` field, so collapsing the ~44 duplicate anilist
//   associations here loses no ranking behaviour.
//
// Only items of KEPT_TYPE ("tv") that carry both an AniList and a Bangumi
// association plus a Chinese translation are emitted, preserving the previous
// map's effective scope.
fn build_bangumi_map(source: &Path, target: &Path) {
    let body = fs::read_to_string(source).expect("read bangumi-data");
    let data: Value = serde_json::from_str(&body).expect("parse bangumi-data");

    let mut by_subject: BTreeMap<String, Value> = BTreeMap::new();
    // anilist id -> representative subject id, preferring a schedule-bearing
    // candidate (all kept entries carry begin, but broadcast/sites vary).
    let mut anilist_index: BTreeMap<String, i64> = BTreeMap::new();

    for item in data["items"].as_array().into_iter().flatten() {
        if item["type"].as_str() != Some(KEPT_TYPE) {
            continue;
        }
        let Some(anilist_id) = site_id(item, "aniList").and_then(|id| id.parse::<i64>().ok())
        else {
            continue;
        };
        let Some(bangumi_id) = site_id(item, "bangumi").and_then(|id| id.parse::<i64>().ok())
        else {
            continue;
        };
        let Some(chinese) =
            first_translation(item, "zh-Hans").or_else(|| first_translation(item, "zh-Hant"))
        else {
            continue;
        };

        let begin = item["begin"].as_str().filter(|value| !value.is_empty());
        let broadcast = item["broadcast"].as_str().filter(|value| !value.is_empty());
        let date = begin.map(|value| value.get(0..10).unwrap_or_default().to_string());
        let format = item["type"].as_str().unwrap_or_default().to_string();
        let title = item["title"].as_str().unwrap_or_default().to_string();
        let sites = qualifying_sites(item);

        let entry = json!({
            "b": bangumi_id,
            "a": anilist_id,
            "c": chinese,
            "t": title,
            "d": date,
            "f": format,
            "begin": begin,
            "broadcast": broadcast,
            "sites": sites,
        });

        let subject_key = bangumi_id.to_string();
        let has_schedule = |entry: &Value| {
            !entry["begin"].is_null()
                || !entry["broadcast"].is_null()
                || entry["sites"].as_array().is_some_and(|sites| !sites.is_empty())
        };
        // On a subject-id collision keep the richer schedule entry.
        match by_subject.get(&subject_key) {
            Some(existing) if has_schedule(existing) && !has_schedule(&entry) => {}
            _ => {
                by_subject.insert(subject_key, entry);
            }
        }
        // On an anilist-id collision any representative is fine: the runtime
        // matcher recovers every candidate by scanning bySubject on `a`.
        anilist_index.insert(anilist_id.to_string(), bangumi_id);
    }

    let mut by_subject_map = Map::new();
    for (subject_id, entry) in by_subject {
        by_subject_map.insert(subject_id, entry);
    }
    let mut anilist_map = Map::new();
    for (anilist_id, subject_id) in anilist_index {
        anilist_map.insert(anilist_id, json!(subject_id));
    }

    let output = json!({
        "version": 2,
        "bySubject": Value::Object(by_subject_map),
        "anilistIndex": Value::Object(anilist_map),
    });
    let encoded = serde_json::to_vec(&output).expect("encode bangumi map");
    let subject_count = output["bySubject"].as_object().map_or(0, |map| map.len());
    let index_count = output["anilistIndex"].as_object().map_or(0, |map| map.len());
    eprintln!(
        "bangumi-data v2 map: {} bytes (~{:.2} MiB); {} subjects, {} anilist entries",
        encoded.len(),
        encoded.len() as f64 / 1_048_576.0,
        subject_count,
        index_count,
    );
    fs::write(target, encoded).expect("write compact bangumi map");
}

fn empty_bangumi_map(target: &Path) {
    fs::write(
        target,
        br#"{"version":2,"bySubject":{},"anilistIndex":{}}"#,
    )
    .expect("write empty bangumi map");
}

fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    let output =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("bangumi-map.json");
    if std::env::var_os("CARGO_FEATURE_STANDARD").is_some() {
        let source = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"))
            .join("../node_modules/bangumi-data/dist/data.json");
        println!("cargo:rerun-if-changed={}", source.display());
        build_bangumi_map(&source, &output);
    } else {
        empty_bangumi_map(&output);
    }
    tauri_build::build()
}
