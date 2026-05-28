//! Apply light / dark design tokens to Slint globals.

use slint::{Color, Global};

use crate::slint_ui::{MainWindow, TrivorTokens};

pub fn apply_theme(ui: &MainWindow, theme: trivor_core::Theme) {
    let tokens = TrivorTokens::get(ui);
    let light = theme == trivor_core::Theme::Light;
    tokens.set_is_light(light);

    tokens.set_text_primary(slint::Brush::SolidColor(if light {
        Color::from_rgb_u8(0x18, 0x18, 0x1b)
    } else {
        Color::from_rgb_u8(0xf4, 0xf4, 0xf5)
    }));
    tokens.set_text_muted(slint::Brush::SolidColor(if light {
        Color::from_rgb_u8(0x6b, 0x6b, 0x76)
    } else {
        Color::from_rgb_u8(0x8b, 0x8b, 0x96)
    }));
    tokens.set_accent(slint::Brush::SolidColor(if light {
        Color::from_rgb_u8(0x6d, 0x5c, 0xe6)
    } else {
        Color::from_rgb_u8(0x8b, 0x7c, 0xf8)
    }));
    tokens.set_accent_hover(slint::Brush::SolidColor(if light {
        Color::from_rgb_u8(0x5b, 0x4a, 0xdb)
    } else {
        Color::from_rgb_u8(0xa5, 0x99, 0xff)
    }));
    tokens.set_accent_soft(slint::Brush::SolidColor(if light {
        Color::from_argb_u8(0x20, 0x6d, 0x5c, 0xe6)
    } else {
        Color::from_argb_u8(0x30, 0x8b, 0x7c, 0xf8)
    }));
    tokens.set_bg_hover(slint::Brush::SolidColor(if light {
        Color::from_argb_u8(0x0e, 0x00, 0x00, 0x00)
    } else {
        Color::from_argb_u8(0x14, 0xff, 0xff, 0xff)
    }));
    tokens.set_border(slint::Brush::SolidColor(if light {
        Color::from_argb_u8(0x14, 0x00, 0x00, 0x00)
    } else {
        Color::from_argb_u8(0x1a, 0xff, 0xff, 0xff)
    }));
    tokens.set_border_strong(slint::Brush::SolidColor(if light {
        Color::from_argb_u8(0x22, 0x00, 0x00, 0x00)
    } else {
        Color::from_argb_u8(0x30, 0xff, 0xff, 0xff)
    }));
}
