//! Tag helpers: [`d3_script()`] and [`d3_stylesheet()`].
//!
//! All scripts are classic `defer` scripts at hashed URLs with SRI. The
//! browser runs deferred scripts in document order after parsing:
//! `d3.min.js` (sets `window.d3`), then `parse.js`, then `init.js`.
//! There is no inline script, so the default Autumn CSP
//! (`script-src 'self'`) allows all tags.

use autumn_web::Markup;

use crate::assets::{D3_ASSETS, D3_CSS, D3_JS, INIT_JS, PARSE_JS};

/// Scripts in load order.
const SCRIPTS: [&str; 3] = [D3_JS, PARSE_JS, INIT_JS];

/// Renders the `<script>` tags that load D3 and the plugin runtime.
///
/// Put it in the page `<head>`. Put your own chart scripts after it, also
/// with `defer`, so they run after `window.d3` and `window.AutumnD3` exist.
///
/// ```rust
/// use autumn_plugin_d3::d3_script;
///
/// let html = d3_script().into_string();
/// assert!(html.contains("/static/_plugins/d3/d3.min."), "{html}");
/// ```
#[must_use]
pub fn d3_script() -> Markup {
    autumn_web::html! {
        @for path in SCRIPTS {
            (D3_ASSETS.deferred_script_tag(path))
        }
    }
}

/// Renders the `<link>` tag for the plugin stylesheet.
///
/// The stylesheet gives charts a default size (`aspect-ratio: 16 / 9`), the
/// palette, and the fallback-table rules. Put it in the page `<head>`.
///
/// ```rust
/// use autumn_plugin_d3::d3_stylesheet;
///
/// let html = d3_stylesheet().into_string();
/// assert!(html.contains(r#"href="/static/_plugins/d3/d3."#), "{html}");
/// ```
#[must_use]
pub fn d3_stylesheet() -> Markup {
    D3_ASSETS.stylesheet_tag(D3_CSS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(path: &str) -> &'static autumn_web::assets::PluginAsset {
        D3_ASSETS.get(path).expect("file is bundled")
    }

    #[test]
    fn scripts_are_deferred_with_sri_at_hashed_urls() {
        let html = d3_script().into_string();
        for path in SCRIPTS {
            let a = asset(path);
            let tag = format!(
                r#"<script src="{}" integrity="{}" crossorigin="anonymous" defer></script>"#,
                a.url(),
                a.integrity()
            );
            assert!(html.contains(&tag), "{path}: {html}");
        }
        assert_eq!(html.matches("<script").count(), 3, "{html}");
    }

    #[test]
    fn scripts_load_in_dependency_order() {
        let html = d3_script().into_string();
        let at = |path| html.find(asset(path).url()).expect("tag");
        assert!(at(D3_JS) < at(PARSE_JS), "{html}");
        assert!(at(PARSE_JS) < at(INIT_JS), "{html}");
    }

    #[test]
    fn stylesheet_link_carries_sri_and_hashed_url() {
        let html = d3_stylesheet().into_string();
        let css = asset(D3_CSS);
        assert!(html.contains(r#"rel="stylesheet""#), "{html}");
        assert!(html.contains(&format!(r#"href="{}""#, css.url())), "{html}");
        assert!(
            html.contains(&format!(r#"integrity="{}""#, css.integrity())),
            "{html}"
        );
    }
}
