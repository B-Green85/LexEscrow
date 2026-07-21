//! Document text extraction — turns a loaded artifact into plain text so the
//! Document Load screen can suggest trust anchors from it (`lib/suggest-anchors`).
//!
//! This is a *convenience* layer, and its error policy reflects that. Only a
//! genuinely missing file is an error; every other failure — an unreadable PDF,
//! a corrupt ZIP, a format we do not handle — yields an empty string. A blank
//! suggestion costs the officer some typing, whereas an error dialog on drop
//! would block a workflow that never needed extraction to proceed. Nothing here
//! feeds LexGuard: ArtifactGuard still hashes the original bytes, and the
//! anchors the officer confirms are what gets validated downstream.
//!
//! Extraction is offered over bytes as well as over a path because the frontend
//! only ever holds browser `File` objects (no filesystem path is exposed to the
//! WebView), matching how `artifact_guard` already receives artifacts.

use std::io::Cursor;
use std::path::Path;
use std::process::Command;

use calamine::{open_workbook_auto, open_workbook_auto_from_rs, Reader};

/// Lowercased final extension, or "" when there is none.
fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ── Plain text ───────────────────────────────────────────────────────────────

/// Lossy rather than strict: a stray non-UTF-8 byte in an otherwise readable
/// document should cost that one character, not the whole extraction.
fn extract_plain(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/// Run poppler's `pdftotext` against a path, returning its stdout.
///
/// `None` distinguishes "poppler is not installed" from "poppler ran and found
/// no text", so only the former falls through to the salvage scan below.
fn pdftotext(path: &Path) -> Option<String> {
    // Try full Homebrew paths first, fall back to PATH — the Tauri process does
    // not inherit Homebrew's bin directory in its PATH, so a bare command name
    // fails to resolve even when poppler is installed.
    let pdftotext = [
        "/opt/homebrew/bin/pdftotext", // Apple Silicon
        "/usr/local/bin/pdftotext",    // Intel Mac
        "/usr/bin/pdftotext",          // Linux
        "pdftotext",                   // PATH fallback
    ]
    .iter()
    .find(|p| std::path::Path::new(p).exists())
    .unwrap_or(&"pdftotext");

    let out = Command::new(pdftotext)
        .args([path.to_str()?, "-"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Position of `needle` in `haystack` at or after `from`.
fn find_at(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Decode one PDF literal string starting just past its opening `(`, returning
/// the text and the index just past the closing `)`.
fn pdf_literal(content: &[u8], start: usize) -> (String, usize) {
    let mut out = String::new();
    let mut depth = 1; // literals may contain balanced parentheses
    let mut i = start;

    while i < content.len() {
        match content[i] {
            b'\\' if i + 1 < content.len() => {
                let e = content[i + 1];
                i += 2;
                match e {
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'b' | b'f' => out.push(' '),
                    b'\n' => {} // line continuation
                    b'0'..=b'7' => {
                        // Octal escape: up to three digits, the first consumed.
                        let mut v = (e - b'0') as u32;
                        let mut n = 1;
                        while n < 3 && i < content.len() && (b'0'..=b'7').contains(&content[i]) {
                            v = v * 8 + (content[i] - b'0') as u32;
                            i += 1;
                            n += 1;
                        }
                        if let Some(c) = char::from_u32(v) {
                            out.push(c);
                        }
                    }
                    other => out.push(other as char),
                }
            }
            b'(' => {
                depth += 1;
                out.push('(');
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return (out, i);
                }
                out.push(')');
            }
            c => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    (out, i)
}

/// Pull the shown text out of a decoded PDF content stream.
///
/// Only the text-showing operators matter: literals inside `Tj` / `TJ` / `'` /
/// `"` are the visible characters, and the positioning operators (`Td`, `TD`,
/// `T*`) are where lines break. Everything else in the stream is graphics state
/// and is skipped. This is deliberately not a full PDF parser — it does not
/// resolve font encodings or CID maps — but for the text-based agreements this
/// screen sees it recovers the labelled values the anchor patterns need.
fn pdf_text_from_content(content: &[u8]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    let mut i = 0;

    while i < content.len() {
        match content[i] {
            b'(' => {
                let (text, next) = pdf_literal(content, i + 1);
                line.push_str(&text);
                i = next;
            }
            // `Td` / `TD` / `T*` all move to a new position — treat as a break.
            b'T' if i + 1 < content.len() => {
                if matches!(content[i + 1], b'd' | b'D' | b'*') && !line.trim().is_empty() {
                    lines.push(line.trim().to_string());
                    line.clear();
                }
                i += 2;
            }
            _ => i += 1,
        }
    }
    if !line.trim().is_empty() {
        lines.push(line.trim().to_string());
    }
    lines.join("\n")
}

/// Decompress every FlateDecode content stream in a PDF and extract its text.
///
/// Returns "" when nothing decodes — the caller then falls back to the ASCII
/// scan. Streams that fail to inflate are skipped rather than aborting the
/// document: a single bad object should not cost the other pages.
fn pdf_text_via_streams(bytes: &[u8]) -> String {
    use std::io::Read;

    let mut out: Vec<String> = Vec::new();
    let mut cursor = 0;

    while let Some(kw) = find_at(bytes, b"stream", cursor) {
        // The stream's dictionary sits immediately before the keyword; that is
        // where the /Filter entry says whether the payload is compressed.
        let dict_start = kw.saturating_sub(512);
        let is_flate = find_at(&bytes[dict_start..kw], b"/FlateDecode", 0).is_some();

        let mut data_start = kw + b"stream".len();
        if bytes.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if bytes.get(data_start) == Some(&b'\n') {
            data_start += 1;
        }

        let Some(end) = find_at(bytes, b"endstream", data_start) else {
            break;
        };
        let raw = &bytes[data_start..end];
        cursor = end + b"endstream".len();

        let decoded = if is_flate {
            let mut buf = Vec::new();
            match flate2::read::ZlibDecoder::new(raw).read_to_end(&mut buf) {
                Ok(_) => buf,
                Err(_) => continue,
            }
        } else {
            raw.to_vec()
        };

        let text = pdf_text_from_content(&decoded);
        if !text.trim().is_empty() {
            out.push(text);
        }
    }

    out.join("\n")
}

/// Last-resort scan for runs of 4+ printable ASCII.
///
/// Emits each run once. A literal `windows(4)` filter would re-emit every
/// character up to four times, turning "Purchase" into "PurcurcchachasseTOTAL".
///
/// This tier recovers very little from a real PDF — body text lives inside
/// compressed streams, and compressed bytes do not survive an ASCII filter, so
/// what is left is object structure. It runs only when both poppler and stream
/// inflation have come up empty, on the principle that partial text beats none.
fn ascii_runs(bytes: &[u8], min_run: usize) -> String {
    let mut out = String::new();
    let mut run: Vec<u8> = Vec::new();

    let flush = |run: &mut Vec<u8>, out: &mut String| {
        if run.len() >= min_run {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&String::from_utf8_lossy(run));
        }
        run.clear();
    };

    for &b in bytes {
        if b.is_ascii_graphic() || b == b' ' {
            run.push(b);
        } else {
            flush(&mut run, &mut out);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// PDF text, in descending order of fidelity. Never fails.
///
///   1. poppler's `pdftotext` — handles font encodings, columns, CID maps.
///   2. built-in FlateDecode stream reader — no external binary needed, and
///      good enough for the text-based agreements this screen sees.
///   3. printable-ASCII salvage — recovers little, but beats nothing.
///
/// Tier 2 exists because poppler is not installed by default on macOS; without
/// it, tier 3 alone returns PDF object structure and no document text at all.
fn extract_pdf(bytes: &[u8], path: Option<&Path>) -> String {
    // poppler needs a real path — spill to a temp file when working from bytes.
    let popplered = match path {
        Some(p) => pdftotext(p),
        None => {
            let temp =
                std::env::temp_dir().join(format!("lexescrow-extract-{}.pdf", uuid::Uuid::new_v4()));
            let out = std::fs::write(&temp, bytes).ok().and_then(|_| pdftotext(&temp));
            let _ = std::fs::remove_file(&temp);
            out
        }
    };
    if let Some(text) = popplered {
        if !text.trim().is_empty() {
            return text;
        }
    }

    let streamed = pdf_text_via_streams(bytes);
    if !streamed.trim().is_empty() {
        return streamed;
    }

    ascii_runs(bytes, 4)
}

fn extract_pdf_path(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => extract_pdf(&bytes, Some(path)),
        Err(_) => String::new(),
    }
}

fn extract_pdf_bytes(bytes: &[u8]) -> String {
    extract_pdf(bytes, None)
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

/// The five predefined XML entities. `&amp;` has to be decoded last so that a
/// literal "&amp;lt;" in the source does not become "<".
fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Strip WordprocessingML down to text, preserving paragraph and row breaks.
///
/// Breaks are converted *before* tags are removed, because after removal there
/// is nothing left to tell one paragraph from the next and every labelled value
/// in the document would run into the following line — which is exactly what
/// the anchor patterns key on.
fn strip_docx_xml(xml: &str) -> String {
    let marked = xml
        .replace("</w:p>", "</w:p>\n")
        .replace("</w:tr>", "</w:tr>\n")
        .replace("<w:br/>", "\n")
        .replace("<w:br />", "\n")
        .replace("<w:tab/>", "\t")
        .replace("<w:tab />", "\t");

    let mut text = String::with_capacity(marked.len() / 2);
    let mut in_tag = false;
    for c in marked.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }

    collapse_whitespace(&decode_entities(&text))
}

/// Trim each line, drop blank ones, and collapse runs of spaces within a line.
/// Line structure is kept — the anchor patterns are line-oriented.
fn collapse_whitespace(s: &str) -> String {
    s.lines()
        .map(|line| {
            line.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_docx(bytes: &[u8]) -> String {
    let mut archive = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(a) => a,
        Err(_) => return String::new(),
    };
    let mut xml = String::new();
    match archive.by_name("word/document.xml") {
        Ok(mut entry) => {
            use std::io::Read;
            if entry.read_to_string(&mut xml).is_err() {
                return String::new();
            }
        }
        Err(_) => return String::new(),
    }
    strip_docx_xml(&xml)
}

// ── Spreadsheets ─────────────────────────────────────────────────────────────

/// Flatten every sheet to `cell | cell` rows under a `--- Sheet: name ---`
/// header. A macro rather than a generic function because the two workbook
/// sources (`open_workbook_auto` over a path, `open_workbook_auto_from_rs` over
/// a cursor) are distinct types whose shared `Reader` bound differs in its
/// associated reader type.
macro_rules! render_workbook {
    ($wb:expr) => {{
        let mut out = String::new();
        let names = $wb.sheet_names().to_owned();
        for name in names {
            if let Ok(range) = $wb.worksheet_range(&name) {
                out.push_str(&format!("\n--- Sheet: {} ---\n", name));
                for row in range.rows() {
                    let cells: Vec<String> = row
                        .iter()
                        .map(|c| c.to_string())
                        .map(|c| c.trim().to_string())
                        .collect();
                    // Skip rows that are entirely empty — spreadsheets are full
                    // of trailing blank rows that would otherwise dominate.
                    if cells.iter().all(|c| c.is_empty()) {
                        continue;
                    }
                    out.push_str(&cells.join(" | "));
                    out.push('\n');
                }
            }
        }
        out
    }};
}

fn extract_spreadsheet_path(path: &Path) -> String {
    match open_workbook_auto(path) {
        Ok(mut wb) => render_workbook!(wb),
        Err(_) => String::new(),
    }
}

fn extract_spreadsheet_bytes(bytes: &[u8]) -> String {
    match open_workbook_auto_from_rs(Cursor::new(bytes.to_vec())) {
        Ok(mut wb) => render_workbook!(wb),
        Err(_) => String::new(),
    }
}

// ── Routing ──────────────────────────────────────────────────────────────────

/// Extract text from in-memory bytes. Never fails; unknown formats yield "".
pub fn extract_from_bytes(file_name: &str, bytes: &[u8]) -> String {
    match extension_of(file_name).as_str() {
        "txt" | "md" => extract_plain(bytes),
        "pdf" => extract_pdf_bytes(bytes),
        "docx" | "dotx" => extract_docx(bytes),
        "xlsx" | "xlsm" | "xls" => extract_spreadsheet_bytes(bytes),
        _ => String::new(),
    }
}

/// Extract text from a file on disk.
///
/// The only error case is a path that does not exist; every readable file
/// resolves to text or to "".
#[tauri::command]
pub async fn extract_document_text(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("File not found".to_string());
    }

    Ok(match extension_of(&file_path).as_str() {
        "txt" | "md" => std::fs::read_to_string(path).map_err(|e| e.to_string())?,
        // Both of these can work from the path directly, avoiding a full read
        // into memory (spreadsheets in particular are read lazily by calamine).
        "pdf" => extract_pdf_path(path),
        "xlsx" | "xlsm" | "xls" => extract_spreadsheet_path(path),
        "docx" | "dotx" => match std::fs::read(path) {
            Ok(bytes) => extract_docx(&bytes),
            Err(_) => String::new(),
        },
        _ => String::new(),
    })
}

/// Extract text from bytes the WebView already holds.
///
/// This is the variant the UI uses: browser `File` objects expose no filesystem
/// path, and the artifact pipeline is byte-oriented throughout.
#[tauri::command]
pub async fn extract_document_text_bytes(
    file_name: String,
    file_bytes: Vec<u8>,
) -> Result<String, String> {
    Ok(extract_from_bytes(&file_name, &file_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A unique scratch path under the OS temp dir.
    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("lexescrow-test-{}-{}", uuid::Uuid::new_v4(), name))
    }

    /// A minimal but structurally valid .docx: a ZIP whose `word/document.xml`
    /// holds one paragraph.
    fn minimal_docx(inner_xml: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(
                format!(
                    r#"<?xml version="1.0"?><w:document xmlns:w="x"><w:body>{}</w:body></w:document>"#,
                    inner_xml
                )
                .as_bytes(),
            )
            .unwrap();
            zw.finish().unwrap();
        }
        buf
    }

    #[tokio::test]
    async fn test_extract_txt() {
        let path = temp_path("doc.txt");
        std::fs::write(&path, "Client: Jane Anderson\nBar No. 123456\n").unwrap();

        let text = extract_document_text(path.to_string_lossy().into_owned())
            .await
            .unwrap();

        assert!(text.contains("Jane Anderson"));
        assert!(text.contains("123456"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn test_extract_md_reads_as_text() {
        let path = temp_path("notes.md");
        std::fs::write(&path, "# Retainer\n\nClient: Marcus Webb\n").unwrap();

        let text = extract_document_text(path.to_string_lossy().into_owned())
            .await
            .unwrap();

        assert!(text.contains("Marcus Webb"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_extract_docx_strips_xml() {
        let docx = minimal_docx("<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>");

        let text = extract_from_bytes("agreement.docx", &docx);

        assert!(text.contains("Hello World"), "got {text:?}");
        assert!(!text.contains("<w:t>"), "tags survived: {text:?}");
        assert!(!text.contains('<'), "markup survived: {text:?}");
    }

    #[test]
    fn test_extract_docx_keeps_paragraphs_apart() {
        // Without the </w:p> → newline step every labelled value would run into
        // the next line, which is precisely what the anchor patterns key on.
        let docx = minimal_docx(
            "<w:p><w:r><w:t>Client: Jane Anderson</w:t></w:r></w:p>\
             <w:p><w:r><w:t>Attorney: Marcus Webb</w:t></w:r></w:p>",
        );

        let text = extract_from_bytes("retainer.docx", &docx);

        assert_eq!(text, "Client: Jane Anderson\nAttorney: Marcus Webb");
    }

    #[test]
    fn test_extract_docx_decodes_entities() {
        let docx = minimal_docx("<w:p><w:r><w:t>Smith &amp; Jones LLP</w:t></w:r></w:p>");

        assert_eq!(extract_from_bytes("firm.docx", &docx), "Smith & Jones LLP");
    }

    #[test]
    fn test_extract_docx_corrupt_zip_returns_empty() {
        // Not an error: a corrupt attachment must not block the workflow.
        assert_eq!(extract_from_bytes("broken.docx", b"this is not a zip"), "");
    }

    /// A minimal but valid .xlsx: the four package parts calamine needs plus one
    /// sheet using inline strings (which avoids a sharedStrings table).
    fn minimal_xlsx(sheet_name: &str, rows: &str) -> Vec<u8> {
        let parts: [(&str, String); 5] = [
            ("[Content_Types].xml", r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>"#.to_string()),
            ("_rels/.rels", r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.to_string()),
            ("xl/workbook.xml", format!(r#"<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets></workbook>"#)),
            ("xl/_rels/workbook.xml.rels", r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_string()),
            ("xl/worksheets/sheet1.xml", format!(r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows}</sheetData></worksheet>"#)),
        ];

        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            let opts = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, body) in parts {
                zw.start_file(name, opts).unwrap();
                zw.write_all(body.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    fn inline_cell(r: &str, v: &str) -> String {
        format!(r#"<c r="{r}" t="inlineStr"><is><t>{v}</t></is></c>"#)
    }

    #[test]
    fn test_extract_xlsx_flattens_cells() {
        let rows = format!(
            r#"<row r="1">{}{}</row><row r="2">{}<c r="B2"><v>485000</v></c></row>"#,
            inline_cell("A1", "Buyer"),
            inline_cell("B1", "Sarah Chen"),
            inline_cell("A2", "Purchase Price"),
        );
        let xlsx = minimal_xlsx("Escrow", &rows);

        let text = extract_from_bytes("terms.xlsx", &xlsx);

        assert!(text.contains("--- Sheet: Escrow ---"), "got {text:?}");
        assert!(text.contains("Buyer | Sarah Chen"), "got {text:?}");
        assert!(text.contains("Purchase Price | 485000"), "got {text:?}");
    }

    #[tokio::test]
    async fn test_extract_xlsx_from_path() {
        let rows = format!(r#"<row r="1">{}</row>"#, inline_cell("A1", "Bar No. 123456"));
        let path = temp_path("ledger.xlsx");
        std::fs::write(&path, minimal_xlsx("Ledger", &rows)).unwrap();

        let text = extract_document_text(path.to_string_lossy().into_owned())
            .await
            .unwrap();

        assert!(text.contains("Bar No. 123456"), "got {text:?}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_extract_xlsx_corrupt_returns_empty() {
        assert_eq!(extract_from_bytes("broken.xlsx", b"not a workbook"), "");
    }





    #[test]
    fn test_extract_unknown_returns_empty() {
        assert_eq!(extract_from_bytes("photo.jpg", b"\xff\xd8\xff\xe0binary"), "");
        assert_eq!(extract_from_bytes("archive.tar.gz", b"junk"), "");
        assert_eq!(extract_from_bytes("noextension", b"junk"), "");
    }

    #[tokio::test]
    async fn test_extract_unknown_extension_path_returns_empty() {
        let path = temp_path("photo.jpg");
        std::fs::write(&path, b"\xff\xd8\xff\xe0").unwrap();

        let text = extract_document_text(path.to_string_lossy().into_owned())
            .await
            .unwrap();

        assert_eq!(text, "");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn test_extract_missing_file_returns_err() {
        let missing = temp_path("nope.txt");

        let result = extract_document_text(missing.to_string_lossy().into_owned()).await;

        assert_eq!(result, Err("File not found".to_string()));
    }

    #[test]
    fn test_extension_matching_is_case_insensitive() {
        let docx = minimal_docx("<w:p><w:r><w:t>Hello World</w:t></w:r></w:p>");
        assert!(extract_from_bytes("AGREEMENT.DOCX", &docx).contains("Hello World"));
        assert_eq!(extract_from_bytes("NOTES.TXT", b"plain"), "plain");
    }

    #[test]
    fn test_ascii_runs_emits_each_run_once() {
        // The overlapping-window form of this filter repeats characters; a run
        // must appear exactly as it does in the source.
        let bytes = b"\x00\x01Purchase Price\x00\x02\x03$485,000.00\x00";

        let out = ascii_runs(bytes, 4);

        assert_eq!(out, "Purchase Price\n$485,000.00");
    }

    #[test]
    fn test_ascii_runs_drops_short_runs() {
        assert_eq!(ascii_runs(b"\x00ab\x00cd\x00", 4), "");
    }

    #[test]
    fn test_pdf_never_errors_on_garbage() {
        // No panic, no error — best-effort text or nothing.
        let _ = extract_from_bytes("scan.pdf", b"\x00\x01\x02not really a pdf");
        assert_eq!(extract_from_bytes("empty.pdf", b""), "");
    }

    /// A PDF whose content stream is FlateDecode-compressed — i.e. what a real
    /// PDF looks like. The salvage scan cannot see into this at all, so it is
    /// the case that decides whether PDF suggestion works without poppler.
    fn compressed_pdf(lines: &[&str]) -> Vec<u8> {
        use flate2::{write::ZlibEncoder, Compression};
        use std::io::Write as _;

        let mut content = String::from("BT /F1 12 Tf 50 750 Td 14 TL\n");
        for l in lines {
            content.push_str(&format!("({l}) Tj T*\n"));
        }
        content.push_str("ET");

        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(content.as_bytes()).unwrap();
        let comp = enc.finish().unwrap();

        let objs: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>".to_vec(),
            [
                format!("<< /Length {} /Filter /FlateDecode >>\nstream\n", comp.len()).into_bytes(),
                comp,
                b"\nendstream".to_vec(),
            ]
            .concat(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        ];

        let mut out = b"%PDF-1.4\n".to_vec();
        for (i, o) in objs.iter().enumerate() {
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(o);
            out.extend_from_slice(b"\nendobj\n");
        }
        out.extend_from_slice(b"trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n");
        out
    }

    #[test]
    fn test_pdf_reads_compressed_content_streams() {
        let pdf = compressed_pdf(&[
            "RESIDENTIAL PURCHASE AGREEMENT",
            "Clearwater County, California",
            "Purchase Price: $485,000.00",
        ]);
        // Prove the premise: none of this is readable from the raw bytes.
        assert!(!pdf.windows(9).any(|w| w == b"Clearwate"));

        let text = extract_from_bytes("agreement.pdf", &pdf);

        assert!(text.contains("Clearwater County, California"), "got {text:?}");
        assert!(text.contains("$485,000.00"), "got {text:?}");
    }

    #[test]
    fn test_pdf_keeps_lines_apart() {
        let pdf = compressed_pdf(&["Buyer: Sarah Chen", "Seller: Robert Diaz"]);

        let text = extract_from_bytes("deal.pdf", &pdf);

        // Runs must not merge, or every labelled value bleeds into the next.
        assert!(text.contains("Buyer: Sarah Chen\n"), "got {text:?}");
        assert!(text.contains("Seller: Robert Diaz"), "got {text:?}");
    }

    #[test]
    fn test_pdf_literal_handles_escapes() {
        let (text, _) = pdf_literal(br"Smith \(Trustee\) \\ Co)", 0);
        assert_eq!(text, r"Smith (Trustee) \ Co");
    }

    #[test]
    fn test_pdf_literal_handles_octal_escapes() {
        let (text, _) = pdf_literal(br"A\102C)", 0);
        assert_eq!(text, "ABC");
    }

    #[test]
    fn test_pdf_literal_handles_nested_parens() {
        let (text, _) = pdf_literal(b"outer (inner) tail)rest", 0);
        assert_eq!(text, "outer (inner) tail");
    }

    #[test]
    fn test_pdf_skips_undecodable_streams_without_losing_the_rest() {
        let mut pdf = compressed_pdf(&["Purchase Price: $485,000.00"]);
        // Splice in a stream that claims Flate but is not.
        let junk = b"6 0 obj\n<< /Filter /FlateDecode >>\nstream\nnot-really-deflate\nendstream\nendobj\n";
        pdf.extend_from_slice(junk);

        let text = extract_from_bytes("mixed.pdf", &pdf);

        assert!(text.contains("$485,000.00"), "got {text:?}");
    }

    #[test]
    fn test_plain_text_survives_invalid_utf8() {
        let bytes = b"Client: Jane\xffAnderson";
        let text = extract_from_bytes("doc.txt", bytes);
        assert!(text.contains("Client:"));
        assert!(text.contains("Anderson"));
    }

    #[tokio::test]
    async fn test_extract_bytes_command_routes_by_name() {
        let text = extract_document_text_bytes("doc.txt".into(), b"Bar No. 123456".to_vec())
            .await
            .unwrap();
        assert_eq!(text, "Bar No. 123456");

        let empty = extract_document_text_bytes("photo.jpg".into(), b"binary".to_vec())
            .await
            .unwrap();
        assert_eq!(empty, "");
    }
}
