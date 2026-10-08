//! [`D3Plugin`]: installs the D3 assets in an Autumn app.
//!
//! The plugin installs [`D3_ASSETS`] through `AppBuilder::plugin_assets`.
//! It reads no configuration and adds no startup hooks.

use std::borrow::Cow;

use autumn_web::app::AppBuilder;
use autumn_web::plugin::Plugin;

use crate::assets::D3_ASSETS;

/// The plugin name in Autumn diagnostics.
pub const PLUGIN_NAME: &str = "autumn-plugin-d3";

/// Installs the D3 assets in an Autumn app.
///
/// ```rust,no_run
/// use autumn_plugin_d3::D3Plugin;
///
/// # async fn run() {
/// autumn_web::app()
///     .plugin(D3Plugin::new())
///     .run()
///     .await;
/// # }
/// ```
///
/// Then put [`d3_stylesheet`](crate::d3_stylesheet) and
/// [`d3_script`](crate::d3_script) in the page, and render a
/// [`Chart`](crate::Chart).
#[derive(Debug, Default, Clone, Copy)]
#[must_use]
pub struct D3Plugin;

impl D3Plugin {
    /// Makes the plugin.
    pub const fn new() -> Self {
        Self
    }
}

impl Plugin for D3Plugin {
    fn name(&self) -> Cow<'static, str> {
        Cow::Borrowed(PLUGIN_NAME)
    }

    fn build(self, app: AppBuilder) -> AppBuilder {
        app.plugin_assets(&D3_ASSETS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::{D3_CSS, D3_JS, INIT_JS, PARSE_JS};
    use autumn_web::assets::{PLUGIN_ASSETS_ROUTE_MARKER, asset_url};
    use autumn_web::plugin_conformance::{ConformanceConfig, run_conformance};
    use autumn_web::route_listing::{RouteClassification, RouteSource};
    use autumn_web::test::{TestApp, TestClient};

    const JS: &str = "text/javascript; charset=utf-8";
    const CSS: &str = "text/css; charset=utf-8";
    const IMMUTABLE: &str = "public, max-age=31536000, immutable";
    const REVALIDATE: &str = "public, max-age=0, must-revalidate";
    const FILES: [&str; 4] = [D3_JS, PARSE_JS, INIT_JS, D3_CSS];

    fn client() -> TestClient {
        TestApp::new().plugin(D3Plugin::new()).build()
    }

    #[tokio::test]
    async fn every_file_serves_at_its_hashed_url() {
        let client = client();
        for path in FILES {
            let response = client.get(&D3_ASSETS.url(path)).send().await;
            let ty = if path == D3_CSS { CSS } else { JS };
            response
                .assert_ok()
                .assert_header("content-type", ty)
                .assert_header("cache-control", IMMUTABLE);
            assert_eq!(
                response.body.as_slice(),
                D3_ASSETS.get(path).expect("bundled").bytes(),
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn d3_js_is_the_umd_build() {
        let response = client().get(&D3_ASSETS.url(D3_JS)).send().await;
        assert!(response.text().contains("d3js.org v7.9.0"));
    }

    #[tokio::test]
    async fn plain_urls_serve_with_revalidation_and_etags() {
        let client = client();
        for path in FILES {
            let plain = format!("/static/_plugins/d3/{path}");
            let response = client.get(&plain).send().await;
            response
                .assert_ok()
                .assert_header("cache-control", REVALIDATE);
            let etag = response.header("etag").expect("etag").to_owned();
            client
                .get(&plain)
                .header("if-none-match", &etag)
                .send()
                .await
                .assert_status(304);
        }
    }

    #[tokio::test]
    async fn provenance_and_stale_paths_are_not_found() {
        let client = client();
        for path in [
            "/static/_plugins/d3/manifest.json",
            "/static/_plugins/d3/D3-LICENSE",
            "/static/_plugins/d3/init.00000000.js",
            "/static/_plugins/d3/nope.js",
        ] {
            client.get(path).send().await.assert_status(404);
        }
    }

    #[tokio::test]
    async fn asset_url_resolves_the_installed_bundle() {
        let _client = client();
        for path in FILES {
            assert_eq!(
                asset_url(&format!("_plugins/d3/{path}")),
                D3_ASSETS.url(path)
            );
        }
    }

    #[test]
    fn bundle_routes_are_public_plugin_routes() {
        let app = autumn_web::app().plugin(D3Plugin::new());
        let infos = app.plugin_route_infos().expect("route infos");
        let routes: Vec<_> = infos
            .iter()
            .filter(|info| info.path.starts_with("/static/_plugins/d3/"))
            .collect();
        assert_eq!(routes.len(), 8, "four files, two URLs each: {infos:?}");
        for info in routes {
            assert_eq!(info.method, "GET");
            assert_eq!(info.classification, RouteClassification::Public);
            assert_eq!(info.middleware, [PLUGIN_ASSETS_ROUTE_MARKER]);
            assert_eq!(info.source, RouteSource::Plugin(PLUGIN_NAME.to_owned()));
        }
    }

    #[test]
    fn plugin_passes_conformance() {
        let app = autumn_web::app().plugin(D3Plugin::new());
        let infos = app.plugin_route_infos().expect("route infos");
        let report = run_conformance(&ConformanceConfig::new(PLUGIN_NAME), &infos);
        assert!(report.passed(), "{}", report.to_text_report());
    }

    #[tokio::test]
    async fn installing_the_plugin_twice_is_harmless() {
        let client = TestApp::new()
            .plugin(D3Plugin::new())
            .plugin(D3Plugin::new())
            .build();
        client.get(&D3_ASSETS.url(INIT_JS)).send().await.assert_ok();
    }

    #[test]
    fn name_is_the_crate_name() {
        assert_eq!(D3Plugin::new().name(), PLUGIN_NAME);
    }
}
