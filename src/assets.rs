//! Vendored D3 assets, embedded at compile time.
//!
//! The bundle holds:
//!
//! - `d3.min.js`: the D3 UMD build (upstream bytes, unchanged).
//! - Plugin files: `parse.js`, `init.js`, `d3.css`.
//!
//! [`D3Plugin`](crate::D3Plugin) installs [`D3_ASSETS`] through
//! `AppBuilder::plugin_assets`. Autumn serves each file under
//! `/static/_plugins/d3/` at a hashed URL (immutable) and at its plain URL
//! (`must-revalidate`). Autumn computes the SRI hashes.
//!
//! `manifest.json` and `D3-LICENSE` are not in the bundle. They are not
//! served.

use autumn_web::assets::PluginAssets;

/// URL namespace of the bundle. Files are served under
/// `/static/_plugins/d3/`.
pub const ASSETS_NAMESPACE: &str = "d3";

/// Pinned D3 version.
pub const D3_VERSION: &str = "7.9.0";

/// jsDelivr URL of the vendored UMD build.
pub const D3_SOURCE: &str = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";

/// `sha384` SRI of the upstream bytes in `assets/d3.min.js`.
///
/// This is a provenance pin. A test fails if the file drifts from it.
pub const D3_JS_INTEGRITY: &str =
    "sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i";

/// D3 UMD build. Sets `window.d3`.
pub(crate) const D3_JS: &str = "d3.min.js";
/// Plugin attribute parsers. Sets `window.AutumnD3Parse`.
pub(crate) const PARSE_JS: &str = "parse.js";
/// Plugin runtime. Sets `window.AutumnD3`.
pub(crate) const INIT_JS: &str = "init.js";
/// Plugin default styles and palette.
pub(crate) const D3_CSS: &str = "d3.css";

/// The plugin asset bundle.
///
/// [`D3Plugin`](crate::D3Plugin) installs it. Use it directly only to make
/// URLs or tags yourself:
///
/// ```rust
/// use autumn_plugin_d3::D3_ASSETS;
///
/// let url = D3_ASSETS.url("init.js");
/// assert!(url.starts_with("/static/_plugins/d3/init."), "{url}");
/// let sri = D3_ASSETS.integrity("init.js").expect("init.js is bundled");
/// assert!(sri.starts_with("sha384-"));
/// ```
pub static D3_ASSETS: PluginAssets = PluginAssets::from_files(
    ASSETS_NAMESPACE,
    &[
        (D3_JS, include_bytes!("../assets/d3.min.js")),
        (PARSE_JS, include_bytes!("../assets/parse.js")),
        (INIT_JS, include_bytes!("../assets/init.js")),
        (D3_CSS, include_bytes!("../assets/d3.css")),
    ],
);

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use sha2::{Digest as _, Sha384};

    /// Recomputes the `sha384` SRI of bytes.
    fn sri(bytes: &[u8]) -> String {
        let digest = Sha384::digest(bytes);
        format!(
            "sha384-{}",
            base64::engine::general_purpose::STANDARD.encode(digest)
        )
    }

    #[test]
    fn bundle_holds_exactly_the_served_files() {
        let files: Vec<&str> = D3_ASSETS
            .iter()
            .map(autumn_web::assets::PluginAsset::logical_path)
            .collect();
        // Sorted by logical path. `manifest.json` and `D3-LICENSE` are absent.
        assert_eq!(files, [D3_CSS, D3_JS, INIT_JS, PARSE_JS]);
        assert_eq!(D3_ASSETS.namespace(), ASSETS_NAMESPACE);
        assert_eq!(D3_ASSETS.mount_path(), "/static/_plugins/d3");
    }

    #[test]
    fn bundle_integrity_matches_embedded_bytes() {
        for asset in D3_ASSETS.iter() {
            assert_eq!(
                asset.integrity(),
                sri(asset.bytes()),
                "{}",
                asset.logical_path()
            );
        }
    }

    #[test]
    fn vendored_d3_matches_the_pinned_upstream_hash() {
        let d3 = D3_ASSETS.get(D3_JS).expect("d3.min.js is bundled");
        assert_eq!(sri(d3.bytes()), D3_JS_INTEGRITY);
        let text = std::str::from_utf8(d3.bytes()).expect("utf-8");
        assert!(text.starts_with(&format!("// https://d3js.org v{D3_VERSION} ")));
    }

    #[test]
    fn urls_are_fingerprinted_under_the_plugin_mount() {
        for asset in D3_ASSETS.iter() {
            let path = asset.logical_path();
            assert_eq!(asset.plain_url(), format!("/static/_plugins/d3/{path}"));
            let (stem, ext) = path.rsplit_once('.').expect("extension");
            let url = asset.url();
            let hash = url
                .strip_prefix(&format!("/static/_plugins/d3/{stem}."))
                .and_then(|rest| rest.strip_suffix(&format!(".{ext}")))
                .unwrap_or_else(|| panic!("{url} is the hashed form of {path}"));
            assert_eq!(hash.len(), 8, "{url}");
            assert!(hash.bytes().all(|b| b.is_ascii_hexdigit()), "{url}");
        }
    }

    #[test]
    fn content_types_match_the_files() {
        let content_type = |path| D3_ASSETS.get(path).expect("bundled").content_type();
        for js in [D3_JS, PARSE_JS, INIT_JS] {
            assert_eq!(content_type(js), "text/javascript; charset=utf-8");
        }
        assert_eq!(content_type(D3_CSS), "text/css; charset=utf-8");
    }

    #[test]
    fn manifest_and_vendor_script_agree_with_constants() {
        let manifest = include_str!("../assets/manifest.json");
        let script = include_str!("../scripts/vendor.sh");
        let pin = D3_JS_INTEGRITY.trim_start_matches("sha384-");
        for (name, text) in [("manifest", manifest), ("vendor.sh", script)] {
            assert!(text.contains(D3_VERSION), "{name} has the version");
            assert!(text.contains(pin), "{name} has the pin");
        }
        assert!(manifest.contains(D3_SOURCE), "manifest has the source URL");
    }
}
