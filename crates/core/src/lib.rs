//! Core domain types for Trivor (极视).

mod summary;
mod theme;

pub use summary::{MaterialSummary, ModelListEntry, SceneSummary};
pub use theme::{Theme, ThemePreference};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalePreference {
    #[default]
    System,
    En,
    ZhHans,
}

/// Resolved locale for runtime strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
    ZhHans,
}
