use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemePreference {
    #[default]
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    Dark,
    Light,
}

impl ThemePreference {
    pub fn resolve(self, system_dark: bool) -> Theme {
        match self {
            ThemePreference::Dark => Theme::Dark,
            ThemePreference::Light => Theme::Light,
            ThemePreference::System => {
                if system_dark {
                    Theme::Dark
                } else {
                    Theme::Light
                }
            }
        }
    }
}
