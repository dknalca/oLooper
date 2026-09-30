//! Public Tablist.net weblooper lookup and audio downloads.

use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::{redirect, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const FIRESTORE_URL: &str = "https://firestore.googleapis.com/v1/projects/tablistnetv2/databases/(default)/documents:runQuery";
const APPCHECK_URL: &str = "https://content-firebaseappcheck.googleapis.com/v1/projects/tablistnetv2/apps/1:1053263465698:web:7d1ffdc3308faab2eb22bb:exchangeRecaptchaV3Token";
const MEILI_SEARCH_URL: &str = "https://search.tablist.net/indexes/nodes/search";
const FIREBASE_APP_ID: &str = "1:1053263465698:web:7d1ffdc3308faab2eb22bb";
// This is Tablist's public web-client key, exposed in its shipped JavaScript.
const FIREBASE_API_KEY: &str = "AIzaSyBLMSnxtXggj733XipMb695QSa21Hwxvow";
const RECAPTCHA_SITE_KEY: &str = "6LeduXIkAAAAAKcQlXdze93kXxKL_krd9XPbNWYZ";
// Tablist's frontend search key is public and is embedded in its shipped app.
const MEILI_SEARCH_KEY: &str = "8f3659dca644e4308ce6c83bdb09921ab126aa7a6872f8b4c0049a6f7de739cd";
const FILES_BASE: &str = "https://files.tablist.net/";
const MAX_TRACK_BYTES: usize = 512 * 1024 * 1024;
const MAX_TRACKS: usize = 100;
const CATALOG_PAGE_SIZE: usize = 24;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TablistTrack {
    pub id: String,
    pub title: String,
    pub path: String,
    pub bpm: Option<f64>,
    pub extension: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TablistPage {
    pub title: String,
    pub path: String,
    pub cover_path: Option<String>,
    pub tracks: Vec<TablistTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablistCatalogLooper {
    pub nid: String,
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub loops: Vec<String>,
    #[serde(default)]
    pub image: String,
    pub path: String,
    #[serde(default)]
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablistCatalogPage {
    pub hits: Vec<TablistCatalogLooper>,
    pub estimated_total_hits: usize,
    pub limit: usize,
    pub offset: usize,
    #[serde(default)]
    pub skipped_invalid_paths: usize,
}

pub fn parse_looper_url(input: &str) -> Result<(Url, String), String> {
    let url =
        Url::parse(input.trim()).map_err(|_| "Enter a valid Tablist looper URL".to_string())?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("tablist.net" | "www.tablist.net"))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTPS URLs from tablist.net are supported".to_string());
    }
    let segments: Vec<_> = url
        .path_segments()
        .ok_or_else(|| "Invalid Tablist URL path".to_string())?
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() != 2 || segments[0] != "looper" || segments[1].contains('/') {
        return Err("Paste a Tablist looper page URL (/looper/<name>)".to_string());
    }
    let page_path = format!("looper/{}", segments[1]);
    Ok((url, page_path))
}

pub fn resolve_page(input: &str, app: &tauri::AppHandle) -> Result<TablistPage, String> {
    let (url, page_path) = parse_looper_url(input)?;
    let query = json!({
        "structuredQuery": {
            "from": [{ "collectionId": "nodes" }],
            "where": { "compositeFilter": {
                "op": "AND",
                "filters": [
                    { "fieldFilter": {
                        "field": { "fieldPath": "published" },
                        "op": "EQUAL",
                        "value": { "booleanValue": true }
                    }},
                    { "fieldFilter": {
                        "field": { "fieldPath": "paths" },
                        "op": "ARRAY_CONTAINS",
                        "value": { "stringValue": page_path }
                    }}
                ]
            }},
            "limit": 1
        }
    });
    let script = firestore_lookup_script(&query)?;
    let value = evaluate_in_tablist_webview(app, url, script)?;
    let document = value
        .as_array()
        .and_then(|rows| rows.iter().find_map(|row| row.get("document")))
        .ok_or_else(|| "No published Tablist looper was found at that URL".to_string())?;
    let mut page = parse_document(document, &page_path)?;
    if page.cover_path.is_none() {
        let slug = page.path.rsplit('/').next().unwrap_or(&page.path);
        match search_loopers(app, slug, 0) {
            Ok(catalog) => {
                page.cover_path = catalog
                    .hits
                    .into_iter()
                    .find(|hit| hit.path == page.path)
                    .map(|hit| hit.image)
                    .filter(|path| !path.trim().is_empty());
                if page.cover_path.is_none() {
                    eprintln!("[oLooper] No cover image indexed for {}", page.path);
                }
            }
            Err(error) => {
                eprintln!("[oLooper] Tablist cover fallback lookup failed: {error}");
            }
        }
    }
    Ok(page)
}

/// Search Tablist's public Meilisearch `nodes` index for loopers, following the
/// same type filter, date sort and 24-row pagination used by its web catalog.
pub fn search_loopers(
    app: &tauri::AppHandle,
    query: &str,
    offset: usize,
) -> Result<TablistCatalogPage, String> {
    search_loopers_with_limit(app, query, offset, CATALOG_PAGE_SIZE)
}

/// Search one bounded catalog window. Smaller limits support global random
/// selection without downloading whole catalog pages.
pub fn search_loopers_with_limit(
    app: &tauri::AppHandle,
    query: &str,
    offset: usize,
    limit: usize,
) -> Result<TablistCatalogPage, String> {
    let query = query.trim();
    if query.chars().count() > 200 {
        return Err("Catalog search is limited to 200 characters".to_string());
    }
    if offset > 100_000 {
        return Err("Catalog offset is outside the supported range".to_string());
    }
    if !(1..=CATALOG_PAGE_SIZE).contains(&limit) {
        return Err(format!(
            "Catalog limit must be between 1 and {CATALOG_PAGE_SIZE}"
        ));
    }
    let request = json!({
        "q": query,
        "filter": "type = \"looper\"",
        "sort": ["date:desc"],
        "limit": limit,
        "offset": offset,
    });
    let script = meili_search_script(&request)?;
    let response = evaluate_in_tablist_webview(
        app,
        Url::parse("https://tablist.net/").map_err(|error| error.to_string())?,
        script,
    )?;
    let mut page: TablistCatalogPage = serde_json::from_value(response)
        .map_err(|error| format!("Tablist search returned an invalid catalog response: {error}"))?;
    let initial_hits = page.hits.len();
    page.hits.retain_mut(|hit| {
        if let Some(path) = normalize_looper_path(&hit.path) {
            hit.path = path;
            true
        } else {
            false
        }
    });
    page.skipped_invalid_paths = initial_hits - page.hits.len();
    Ok(page)
}

/// Tablist protects its public Firestore reads with Firebase App Check. Obtain
/// its short-lived reCAPTCHA token in a real tablist.net webview, then perform
/// the same published-node query with the App Check token. The remote page is
/// never given Tauri IPC access; data is returned through eval's result callback.
fn evaluate_in_tablist_webview(
    app: &tauri::AppHandle,
    url: reqwest::Url,
    script: String,
) -> Result<Value, String> {
    use tauri::{webview::PageLoadEvent, WebviewUrl, WebviewWindowBuilder};

    static NEXT_WEBVIEW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!(
        "tablist-import-{}",
        NEXT_WEBVIEW.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let (loaded_tx, loaded_rx) = std::sync::mpsc::channel();
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Tablist import")
        .visible(false)
        .on_page_load(move |_webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = loaded_tx.send(());
            }
        })
        .build()
        .map_err(|error| format!("Could not open Tablist's public page: {error}"))?;

    let result = (|| {
        loaded_rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Timed out loading the Tablist page for authorization".to_string())?;
        window
            .eval(&script)
            .map_err(|error| format!("Could not start Tablist authorization: {error}"))?;

        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        while std::time::Instant::now() < deadline {
            let (result_tx, result_rx) = std::sync::mpsc::channel();
            window
                .eval_with_callback(
                    "window.__olooperTablistLookup === null ? null : JSON.stringify(window.__olooperTablistLookup)",
                    move |value| {
                        let _ = result_tx.send(value);
                    },
                )
                .map_err(|error| format!("Could not read Tablist response: {error}"))?;
            let callback = result_rx
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "Timed out waiting for Tablist authorization".to_string())?;
            let value = parse_eval_json(&callback)?;
            if !value.is_null() {
                if let Some(error) = value.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                return value
                    .get("data")
                    .cloned()
                    .ok_or_else(|| "Tablist returned an empty looper response".to_string());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("Timed out obtaining Tablist's public looper data".to_string())
    })();
    let _ = window.close();
    result
}

fn firestore_lookup_script(query: &Value) -> Result<String, String> {
    let query_json = serde_json::to_string(query).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"window.__olooperTablistLookup = null;
            (async () => {{
              try {{
                const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                const deadline = Date.now() + 20000;
                while ((!window.grecaptcha || !window.grecaptcha.render) && Date.now() < deadline) await wait(100);
                if (!window.grecaptcha || !window.grecaptcha.render) throw new Error('Tablist reCAPTCHA did not initialize');
                const element = document.createElement('div');
                element.style.display = 'none';
                document.body.appendChild(element);
                const widget = await new Promise((resolve, reject) => {{
                  window.grecaptcha.ready(() => {{
                    try {{ resolve(window.grecaptcha.render(element, {{ sitekey: {site_key}, size: 'invisible' }})); }}
                    catch (error) {{ reject(error); }}
                  }});
                }});
                const recaptchaToken = await window.grecaptcha.execute(widget, {{ action: 'fire_app_check' }});
                const appCheckResponse = await fetch({appcheck_url} + '?key=' + {api_key}, {{
                  method: 'POST',
                  headers: {{ 'Content-Type': 'application/json' }},
                  body: JSON.stringify({{ recaptcha_v3_token: recaptchaToken }})
                }});
                const appCheckBody = await appCheckResponse.json();
                if (!appCheckResponse.ok) throw new Error('Tablist App Check authorization failed: ' + JSON.stringify({{ status: appCheckResponse.status, response: appCheckBody }}, null, 2));
                const appCheck = appCheckBody;
                const response = await fetch({firestore_url} + '?key=' + {api_key}, {{
                  method: 'POST',
                  headers: {{ 'Content-Type': 'application/json', 'X-Firebase-AppCheck': appCheck.token, 'X-Firebase-GMPID': {app_id} }},
                  body: JSON.stringify({query})
                }});
                const body = await response.json();
                if (!response.ok) throw new Error('Tablist Firestore lookup failed: ' + JSON.stringify({{ status: response.status, statusText: response.statusText, response: body }}, null, 2));
                const nodeDocument = body.find(row => row.document)?.document;
                if (!nodeDocument) throw new Error('No published Tablist looper was found at that URL');
                const fields = nodeDocument.fields || {{}};
                window.__olooperTablistLookup = {{ data: [{{ document: {{ fields: {{ title: fields.title, loops: fields.loops }} }} }}] }};
              }} catch (error) {{
                window.__olooperTablistLookup = {{ error: String(error?.message || error) }};
              }}
            }})();"#,
        site_key = serde_json::to_string(RECAPTCHA_SITE_KEY).unwrap(),
        appcheck_url = serde_json::to_string(APPCHECK_URL).unwrap(),
        firestore_url = serde_json::to_string(FIRESTORE_URL).unwrap(),
        api_key = serde_json::to_string(FIREBASE_API_KEY).unwrap(),
        app_id = serde_json::to_string(FIREBASE_APP_ID).unwrap(),
        query = query_json,
    ))
}

fn meili_search_script(request: &Value) -> Result<String, String> {
    let request_json = serde_json::to_string(request).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"window.__olooperTablistLookup = null;
        (async () => {{
          try {{
            const response = await fetch({endpoint}, {{
              method: 'POST',
              headers: {{
                'Authorization': 'Bearer ' + {api_key},
                'Content-Type': 'application/json'
              }},
              body: JSON.stringify({request})
            }});
            const body = await response.json();
            if (!response.ok) throw new Error('Tablist catalog search failed: ' + JSON.stringify({{status: response.status, response: body}}, null, 2));
            const hits = (body.hits || []).map(hit => ({{
              nid: String(hit.nid ?? ''),
              title: String(hit.title ?? 'Untitled looper'),
              tags: Array.isArray(hit.tags) ? hit.tags : [],
              loops: Array.isArray(hit.loops) ? hit.loops : [],
              image: String(hit.image ?? ''),
              path: String(hit.path ?? ''),
              date: String(hit.date ?? '')
            }}));
            window.__olooperTablistLookup = {{data: {{
              hits,
              estimatedTotalHits: Number(body.estimatedTotalHits || 0),
              limit: Number(body.limit || {page_size}),
              offset: Number(body.offset || 0)
            }}}};
          }} catch (error) {{
            window.__olooperTablistLookup = {{error: String(error?.message || error)}};
          }}
        }})();"#,
        endpoint = serde_json::to_string(MEILI_SEARCH_URL).unwrap(),
        api_key = serde_json::to_string(MEILI_SEARCH_KEY).unwrap(),
        page_size = CATALOG_PAGE_SIZE,
        request = request_json,
    ))
}

fn normalize_looper_path(path: &str) -> Option<String> {
    let path = path.trim();
    let route = if path.starts_with("https://") {
        let url = Url::parse(path).ok()?;
        if !matches!(url.host_str(), Some("tablist.net" | "www.tablist.net")) {
            return None;
        }
        url.path().to_string()
    } else if path.starts_with("http://") || path.starts_with("//") {
        return None;
    } else {
        path.to_string()
    };
    let route = route.split(['?', '#']).next()?.trim_matches('/');
    let mut segments = route.split('/');
    let (Some("looper"), Some(slug), None) = (segments.next(), segments.next(), segments.next())
    else {
        return None;
    };
    if slug.is_empty()
        || slug == "."
        || slug == ".."
        || slug.contains('\\')
        || slug.chars().any(char::is_control)
    {
        return None;
    }
    Some(format!("looper/{slug}"))
}

fn parse_eval_json(value: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(value)
        .map_err(|error| format!("Tablist webview returned invalid data: {error}"))?;
    match parsed {
        Value::String(serialized) => serde_json::from_str(&serialized)
            .map_err(|error| format!("Tablist webview returned invalid data: {error}")),
        other => Ok(other),
    }
}

pub fn download_track(track: &TablistTrack, page_url: &str) -> Result<Vec<u8>, String> {
    let url = remote_file_url(&track.path)?;
    let client = client_for("files.tablist.net")?;
    let response = client
        .get(url)
        .header(reqwest::header::REFERER, page_url)
        .header(reqwest::header::ORIGIN, "https://tablist.net")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        )
        .send()
        .map_err(|error| format!("Could not download '{}': {error}", track.title))?;
    let response = checked_response(response, "Tablist audio download")?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TRACK_BYTES as u64)
    {
        return Err(format!("'{}' exceeds the 512 MiB limit", track.title));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_TRACK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read '{}': {error}", track.title))?;
    if bytes.len() > MAX_TRACK_BYTES {
        return Err(format!("'{}' exceeds the 512 MiB limit", track.title));
    }
    Ok(bytes)
}

pub fn download_cover(path: &str, page_url: &str) -> Result<Vec<u8>, String> {
    const MAX_COVER_BYTES: u64 = 10 * 1024 * 1024;
    let url = remote_file_url(path)?;
    let response = client_for("files.tablist.net")?
        .get(url)
        .header(reqwest::header::REFERER, page_url)
        .header(reqwest::header::ORIGIN, "https://tablist.net")
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        )
        .send()
        .map_err(|error| format!("Could not download Tablist cover: {error}"))?;
    let response = checked_response(response, "Tablist cover download")?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_COVER_BYTES)
    {
        return Err("Tablist cover exceeds the 10 MiB limit".to_string());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_COVER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Tablist cover: {error}"))?;
    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err("Tablist cover exceeds the 10 MiB limit".to_string());
    }
    Ok(bytes)
}

fn client_for(host: &'static str) -> Result<Client, String> {
    static RUSTLS_PROVIDER: OnceLock<()> = OnceLock::new();
    RUSTLS_PROVIDER.get_or_init(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
    });
    Client::builder()
        .timeout(Duration::from_secs(45))
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.url().scheme() == "https" && attempt.url().host_str() == Some(host) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|error| format!("Could not prepare secure Tablist connection: {error}"))
}

fn checked_response(response: Response, operation: &str) -> Result<Response, String> {
    if response.status().is_success() {
        Ok(response)
    } else {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        let detail: String = body.chars().take(2000).collect();
        Err(format!("{operation} failed with HTTP {status}: {detail}"))
    }
}

fn remote_file_url(path: &str) -> Result<Url, String> {
    let value = path.trim();
    if value.is_empty() || value.contains('\\') || value.chars().any(char::is_control) {
        return Err("Tablist returned an invalid audio path".to_string());
    }
    let url = if value.starts_with("https://") {
        Url::parse(value).map_err(|_| "Tablist returned an invalid audio URL".to_string())?
    } else if value.starts_with("http://") || value.starts_with("//") {
        return Err("Tablist audio must use HTTPS".to_string());
    } else {
        if value.split('/').any(|part| part == "..") {
            return Err("Tablist returned an unsafe audio path".to_string());
        }
        Url::parse(FILES_BASE)
            .and_then(|base| base.join(value.trim_start_matches('/')))
            .map_err(|_| "Tablist returned an invalid audio path".to_string())?
    };
    if url.scheme() != "https"
        || url.host_str() != Some("files.tablist.net")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Tablist audio URL is outside files.tablist.net".to_string());
    }
    Ok(url)
}

fn parse_document(document: &Value, fallback_path: &str) -> Result<TablistPage, String> {
    let fields = document
        .get("fields")
        .ok_or_else(|| "Tablist looper data is missing fields".to_string())?;
    let title = field_string(fields, "title").unwrap_or_else(|| fallback_path.to_string());
    let loops = fields
        .get("loops")
        .and_then(firestore_value)
        .and_then(Value::as_array)
        .ok_or_else(|| "This Tablist page has no downloadable loop tracks".to_string())?;
    if loops.is_empty() {
        return Err("This Tablist page has no downloadable loop tracks".to_string());
    }
    if loops.len() > MAX_TRACKS {
        return Err(format!(
            "This Tablist page exceeds the {MAX_TRACKS}-track limit"
        ));
    }
    let tracks = loops
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let item_fields = firestore_value(item).unwrap_or(item);
            let id = field_string(item_fields, "id")
                .or_else(|| field_string(item_fields, "path"))
                .unwrap_or_else(|| format!("track-{}", index + 1));
            let path = field_string(item_fields, "path")
                .ok_or_else(|| format!("Tablist track {} has no audio path", index + 1))?;
            let url = remote_file_url(&path)?;
            let extension = url
                .path_segments()
                .and_then(|segments| segments.last())
                .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext))
                .filter(|ext| {
                    matches!(
                        ext.to_ascii_lowercase().as_str(),
                        "wav" | "mp3" | "ogg" | "flac" | "m4a" | "aac"
                    )
                })
                .map(str::to_ascii_lowercase)
                .unwrap_or_else(|| "audio".to_string());
            let title = field_string(item_fields, "title")
                .or_else(|| field_string(item_fields, "name"))
                .unwrap_or_else(|| format!("Loop {}", index + 1));
            let bpm = field_number(item_fields, "bpm").filter(|bpm| (20.0..=300.0).contains(bpm));
            Ok(TablistTrack {
                id,
                title,
                path,
                bpm,
                extension,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let cover_path = fields
        .get("images")
        .and_then(firestore_value)
        .and_then(Value::as_array)
        .and_then(|images| images.first())
        .and_then(firestore_value)
        .and_then(|image| {
            ["path800", "path420", "path", "path65"]
                .iter()
                .find_map(|field| field_string(image, field))
        })
        .or_else(|| field_string(fields, "image"))
        .filter(|path| !path.trim().is_empty());
    Ok(TablistPage {
        title,
        path: fallback_path.to_string(),
        cover_path,
        tracks,
    })
}

fn firestore_value(value: &Value) -> Option<&Value> {
    [
        "stringValue",
        "integerValue",
        "doubleValue",
        "booleanValue",
        "arrayValue",
        "mapValue",
        "nullValue",
    ]
    .iter()
    .find_map(|key| value.get(*key))
    .map(|value| {
        if let Some(values) = value.get("values") {
            values
        } else if let Some(fields) = value.get("fields") {
            fields
        } else {
            value
        }
    })
}

fn field_string(fields: &Value, name: &str) -> Option<String> {
    let value = firestore_value(fields.get(name)?)?;
    value.as_str().map(str::to_string)
}

fn field_number(fields: &Value, name: &str) -> Option<f64> {
    let value = firestore_value(fields.get(name)?)?;
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_reqwest_client_builds_with_the_selected_rustls_provider() {
        assert!(client_for("files.tablist.net").is_ok());
    }

    #[test]
    fn accepts_only_tablist_looper_pages() {
        let (_, path) = parse_looper_url("https://tablist.net/looper/example/").unwrap();
        assert_eq!(path, "looper/example");
        assert!(parse_looper_url("http://tablist.net/looper/example").is_err());
        assert!(parse_looper_url("https://tablist.net.evil.test/looper/example").is_err());
        assert!(parse_looper_url("https://tablist.net/looper/a/other").is_err());
    }

    #[test]
    fn reads_loops_from_firestore_document_shape() {
        let doc = json!({ "fields": {
            "title": { "stringValue": "Test Looper" },
            "images": { "arrayValue": { "values": [
                { "mapValue": { "fields": {
                    "path800": { "stringValue": "loopers/test/cover.jpg" }
                }}}
            ]}},
            "loops": { "arrayValue": { "values": [
                { "mapValue": { "fields": {
                    "id": { "stringValue": "loop-a" },
                    "name": { "stringValue": "Track A" },
                    "path": { "stringValue": "loopers/test/a.mp3" },
                    "bpm": { "doubleValue": 123.5 }
                }}}
            ]}}
        }});
        let page = parse_document(&doc, "looper/test").unwrap();
        assert_eq!(page.title, "Test Looper");
        assert_eq!(page.cover_path.as_deref(), Some("loopers/test/cover.jpg"));
        assert_eq!(page.tracks[0].id, "loop-a");
        assert_eq!(page.tracks[0].title, "Track A");
        assert_eq!(page.tracks[0].bpm, Some(123.5));
        assert_eq!(page.tracks[0].extension, "mp3");
    }

    #[test]
    fn decodes_meilisearch_catalog_page() {
        let page: TablistCatalogPage = serde_json::from_value(json!({
            "hits": [{
                "nid": "3557",
                "title": "Sonny Kraft - Friendly Melodies",
                "tags": ["Sonny Kraft"],
                "loops": ["1 - Friendly Melodies", "2 - Friendly Melodies"],
                "image": "3557/thumb.jpg",
                "path": "looper/sonny-kraft-friendly-melodies",
                "date": "2026-09-24"
            }],
            "estimatedTotalHits": 12,
            "limit": 24,
            "offset": 0
        }))
        .unwrap();
        assert_eq!(page.estimated_total_hits, 12);
        assert_eq!(page.hits[0].loops.len(), 2);
        assert_eq!(page.hits[0].image, "3557/thumb.jpg");
        assert_eq!(page.hits[0].path, "looper/sonny-kraft-friendly-melodies");
        assert_eq!(
            normalize_looper_path("/looper/example/"),
            Some("looper/example".to_string())
        );
        assert_eq!(
            normalize_looper_path("https://tablist.net/looper/example?q=1"),
            Some("looper/example".to_string())
        );
        assert!(normalize_looper_path("https://attacker.test/looper/x").is_none());
    }

    #[test]
    fn search_script_sends_meilisearch_request_as_json() {
        let request = json!({
            "q": "sonny",
            "filter": "type = \"looper\"",
            "sort": ["date:desc"],
            "limit": 24,
            "offset": 24
        });
        let script = meili_search_script(&request).unwrap();
        assert!(script.contains("https://search.tablist.net/indexes/nodes/search"));
        assert!(script.contains("Authorization"));
        let request_body = script
            .split("body: JSON.stringify(")
            .nth(1)
            .unwrap()
            .split(")")
            .next()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(request_body).unwrap(),
            request
        );
    }

    #[test]
    fn rejects_audio_paths_outside_tablist_files_host() {
        assert!(remote_file_url("https://attacker.test/audio.mp3").is_err());
        assert!(remote_file_url("http://files.tablist.net/audio.mp3").is_err());
        assert!(remote_file_url("../private/audio.mp3").is_err());
        assert_eq!(
            remote_file_url("looper/audio.mp3").unwrap().as_str(),
            "https://files.tablist.net/looper/audio.mp3"
        );
    }

    #[test]
    fn parses_webview_eval_callback_json() {
        assert_eq!(
            parse_eval_json(r#""{\"data\":[]}""#).unwrap(),
            json!({ "data": [] })
        );
        assert_eq!(parse_eval_json("null").unwrap(), Value::Null);
    }

    #[test]
    fn firestore_request_serializes_its_query_body() {
        let query = json!({ "structuredQuery": { "from": [{ "collectionId": "nodes" }] } });
        let script = firestore_lookup_script(&query).unwrap();
        let body = script
            .split("'X-Firebase-AppCheck': appCheck.token")
            .nth(1)
            .unwrap()
            .split("body: JSON.stringify(")
            .nth(1)
            .unwrap()
            .split(')')
            .next()
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(body).unwrap(), query);
    }
}
