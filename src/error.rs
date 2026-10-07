//! The crate error type.

/// An error from the chart builder.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// A custom kind name is not valid. See
    /// [`Chart::custom`](crate::Chart::custom).
    #[error(
        "invalid custom chart kind {0:?}: use 1-64 of a-z, 0-9, -; start with a letter; do not use a built-in name"
    )]
    InvalidKind(String),
    /// Custom data did not serialize to JSON.
    #[error("chart data does not serialize to JSON: {0}")]
    Json(#[from] serde_json::Error),
}
