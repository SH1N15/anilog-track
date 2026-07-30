use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

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

fn build_bangumi_map(source: &Path, target: &Path) {
    let body = fs::read_to_string(source).expect("read bangumi-data");
    let data: Value = serde_json::from_str(&body).expect("parse bangumi-data");
    let mut grouped: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for item in data["items"].as_array().into_iter().flatten() {
        let Some(anilist_id) = site_id(item, "aniList") else {
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
        grouped.entry(anilist_id).or_default().push(json!({
            "b": bangumi_id,
            "c": chinese,
            "t": item["title"].as_str().unwrap_or_default(),
            "d": item["begin"].as_str().unwrap_or_default().get(0..10).unwrap_or_default(),
            "f": item["type"].as_str().unwrap_or_default()
        }));
    }
    let mut output = Map::new();
    for (id, mut candidates) in grouped {
        if candidates.len() == 1 {
            let candidate = candidates.remove(0);
            output.insert(id, json!({"b": candidate["b"], "c": candidate["c"]}));
        } else {
            output.insert(id, Value::Array(candidates));
        }
    }
    fs::write(target, serde_json::to_vec(&Value::Object(output)).unwrap())
        .expect("write compact bangumi map");
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
        fs::write(output, b"{}").expect("write empty bangumi map");
    }
    tauri_build::build()
}
