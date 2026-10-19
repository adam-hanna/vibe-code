//! The pairing QR code as a matrix the window draws (#341).
//!
//! Rendered here rather than in the window so the app gains no QR package, and
//! returned as modules rather than an image so the window draws it as SVG in
//! token colours - no hex outside `tokens.css`.

use qrcode::{Color, QrCode};
use serde::Serialize;

/// A square of modules, `true` for dark. No quiet zone: the window adds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub size: usize,
    pub rows: Vec<Vec<bool>>,
}

pub fn matrix(text: &str) -> Result<QrMatrix, String> {
    let code = QrCode::new(text.as_bytes()).map_err(|e| format!("the pairing code could not be drawn: {e}"))?;
    let size = code.width();
    let colors = code.to_colors();
    let rows = colors
        .chunks(size)
        .map(|row| row.iter().map(|c| *c == Color::Dark).collect())
        .collect();
    Ok(QrMatrix { size, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payload_becomes_a_square_with_its_finder_patterns() {
        let text = format!("vibe-pair:1?id={}&s={}&n=desktop", "a".repeat(64), "b".repeat(64));
        let m = matrix(&text).expect("draws");
        assert_eq!(m.rows.len(), m.size);
        assert!(m.rows.iter().all(|r| r.len() == m.size));
        // The top-left finder pattern's first row is seven dark modules.
        assert!(m.rows[0][0..7].iter().all(|&d| d));
        assert!(!m.rows[0][7], "and a light separator after it");
    }
}
