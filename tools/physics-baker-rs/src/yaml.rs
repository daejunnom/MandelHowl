//! Deterministic parser for the audited YAML subset used by MandelHowl specs.

use crate::json::{Map, Value, from_str as parse_json};

#[derive(Debug, Clone)]
struct Row {
    indent: usize,
    content: String,
    line: usize,
}

pub fn parse(source: &str) -> Result<Value, String> {
    let mut rows = Vec::new();
    for (index, raw) in source.lines().enumerate() {
        let line = index + 1;
        let leading = raw.len() - raw.trim_start_matches([' ', '\t']).len();
        if raw[..leading].contains('\t') {
            return Err(format!("tabs are forbidden at YAML line {line}"));
        }
        let clean = strip_comment(raw).trim_end();
        if clean.trim().is_empty() {
            continue;
        }
        let indent = clean.len() - clean.trim_start_matches(' ').len();
        if !indent.is_multiple_of(2) {
            return Err(format!(
                "YAML indentation must use two-space steps at line {line}"
            ));
        }
        rows.push(Row {
            indent,
            content: clean.trim_start().to_owned(),
            line,
        });
    }
    if rows.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    if rows[0].indent != 0 || rows[0].content.starts_with("- ") {
        return Err("YAML root must be a zero-indented mapping".to_owned());
    }
    let mut index = 0;
    let value = parse_block(&rows, &mut index, 0)?;
    if index != rows.len() {
        return Err(format!(
            "unexpected YAML indentation at line {}",
            rows[index].line
        ));
    }
    Ok(value)
}

fn parse_block(rows: &[Row], index: &mut usize, indent: usize) -> Result<Value, String> {
    let row = rows
        .get(*index)
        .ok_or_else(|| "unexpected end of YAML input".to_owned())?;
    if row.indent != indent {
        return Err(format!(
            "expected YAML indentation {indent} at line {}",
            row.line
        ));
    }
    if row.content.starts_with("- ") {
        parse_sequence(rows, index, indent)
    } else {
        parse_mapping(rows, index, indent)
    }
}

fn parse_mapping(rows: &[Row], index: &mut usize, indent: usize) -> Result<Value, String> {
    let mut object = Map::new();
    while let Some(row) = rows.get(*index) {
        if row.indent < indent {
            break;
        }
        if row.indent > indent {
            return Err(format!("unexpected YAML indentation at line {}", row.line));
        }
        if row.content.starts_with("- ") {
            break;
        }
        let (key, scalar) = split_mapping(&row.content)
            .ok_or_else(|| format!("expected key:value mapping at line {}", row.line))?;
        if key.is_empty() || object.contains_key(key) {
            return Err(format!(
                "empty or duplicate YAML key {key:?} at line {}",
                row.line
            ));
        }
        let key = key.to_owned();
        *index += 1;
        let value = if scalar.is_empty() {
            let child = rows
                .get(*index)
                .ok_or_else(|| format!("missing YAML child for {key:?}"))?;
            if child.indent <= indent {
                return Err(format!("missing YAML child for {key:?}"));
            }
            parse_block(rows, index, child.indent)?
        } else {
            parse_scalar(scalar)?
        };
        object.insert(key, value);
    }
    Ok(Value::Object(object))
}

fn parse_sequence(rows: &[Row], index: &mut usize, indent: usize) -> Result<Value, String> {
    let mut output = Vec::new();
    while let Some(row) = rows.get(*index) {
        if row.indent < indent {
            break;
        }
        if row.indent != indent || !row.content.starts_with("- ") {
            break;
        }
        let item_text = row.content[2..].trim();
        if item_text.is_empty() {
            return Err(format!("empty YAML sequence item at line {}", row.line));
        }
        let item_line = row.line;
        *index += 1;
        if let Some((key, scalar)) = split_mapping(item_text) {
            if key.is_empty() {
                return Err(format!("empty YAML key at line {item_line}"));
            }
            let mut object = Map::new();
            if scalar.is_empty() {
                let child = rows
                    .get(*index)
                    .ok_or_else(|| format!("missing YAML child at line {item_line}"))?;
                if child.indent <= indent {
                    return Err(format!("missing YAML child at line {item_line}"));
                }
                object.insert(key.to_owned(), parse_block(rows, index, child.indent)?);
            } else {
                object.insert(key.to_owned(), parse_scalar(scalar)?);
            }
            if rows
                .get(*index)
                .is_some_and(|next| next.indent > indent && !next.content.starts_with("- "))
            {
                let child_indent = rows[*index].indent;
                let continuation = parse_mapping(rows, index, child_indent)?;
                let continuation = continuation
                    .as_object()
                    .expect("parse_mapping returns an object");
                for (key, value) in continuation {
                    if object.insert(key.clone(), value.clone()).is_some() {
                        return Err(format!(
                            "duplicate YAML sequence mapping key {key:?} at line {item_line}"
                        ));
                    }
                }
            }
            output.push(Value::Object(object));
        } else {
            output.push(parse_scalar(item_text)?);
        }
    }
    Ok(Value::Array(output))
}

fn strip_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            quote = if quote == Some(character) {
                None
            } else if quote.is_none() {
                Some(character)
            } else {
                quote
            };
            continue;
        }
        if character == '#' && quote.is_none() {
            return &line[..index];
        }
    }
    line
}

fn split_mapping(text: &str) -> Option<(&str, &str)> {
    let mut quote = None;
    let mut depth = 0_i32;
    for (index, character) in text.char_indices() {
        if matches!(character, '\'' | '"') {
            quote = if quote == Some(character) {
                None
            } else if quote.is_none() {
                Some(character)
            } else {
                quote
            };
        } else if quote.is_none() {
            match character {
                '[' | '{' => depth += 1,
                ']' | '}' => depth -= 1,
                ':' if depth == 0 => {
                    return Some((text[..index].trim(), text[index + 1..].trim()));
                }
                _ => {}
            }
        }
    }
    None
}

fn parse_scalar(text: &str) -> Result<Value, String> {
    if text.is_empty() {
        return Err("empty YAML scalar".to_owned());
    }
    if text.starts_with(['&', '*', '!', '|', '>']) {
        return Err(format!("unsupported YAML construct {text:?}"));
    }
    if text.starts_with(['"', '[', '{']) {
        return parse_json(text)
            .map_err(|error| format!("invalid JSON-style YAML scalar: {error}"));
    }
    if text.starts_with('\'') && text.ends_with('\'') && text.len() >= 2 {
        return Ok(Value::String(text[1..text.len() - 1].replace("''", "'")));
    }
    match text.to_ascii_lowercase().as_str() {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        "null" | "~" => return Ok(Value::Null),
        _ => {}
    }
    if is_decimal_number(text) {
        let value = text
            .parse::<f64>()
            .map_err(|_| format!("invalid YAML number {text:?}"))?;
        if !value.is_finite() {
            return Err("non-finite YAML numbers are forbidden".to_owned());
        }
        return Ok(Value::Number(value));
    }
    Ok(Value::String(text.to_owned()))
}

fn is_decimal_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let mut index = usize::from(matches!(bytes[0], b'+' | b'-'));
    if index == bytes.len() {
        return false;
    }
    let integer_start = index;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
    }
    if index == integer_start {
        return false;
    }
    if bytes[integer_start] == b'0'
        && index - integer_start > 1
        && bytes.get(integer_start + 1) != Some(&b'.')
    {
        return false;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == fraction_start {
            return false;
        }
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mapping_sequences_and_inline_arrays() {
        let value = parse("root:\n  pair: [0, 1]\n  rows:\n    - name: a\n      value: 2\n")
            .expect("parse");
        assert_eq!(
            value
                .get("root")
                .and_then(|value| value.get("rows"))
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
    }
}
