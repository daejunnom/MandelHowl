use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub type Map = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Map),
}

impl Value {
    pub fn as_object(&self) -> Option<&Map> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_object_mut(&mut self) -> Option<&mut Map> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        let value = self.as_f64()?;
        if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= u64::MAX as f64 {
            Some(value as u64)
        } else {
            None
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object()?.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.as_object_mut()?.get_mut(key)
    }
}

pub trait ToJson {
    fn to_json(&self) -> Result<Value, String>;
}

pub fn to_value<T: ToJson + ?Sized>(value: &T) -> Result<Value, String> {
    value.to_json()
}

impl ToJson for Value {
    fn to_json(&self) -> Result<Value, String> {
        Ok(self.clone())
    }
}

impl ToJson for &Value {
    fn to_json(&self) -> Result<Value, String> {
        Ok((*self).clone())
    }
}

impl ToJson for str {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::String(self.to_owned()))
    }
}

impl ToJson for &str {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::String((*self).to_owned()))
    }
}

impl ToJson for String {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::String(self.clone()))
    }
}

impl ToJson for bool {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::Bool(*self))
    }
}

macro_rules! integer_json {
    ($($kind:ty),* $(,)?) => {
        $(
            impl ToJson for $kind {
                fn to_json(&self) -> Result<Value, String> {
                    Ok(Value::Number(*self as f64))
                }
            }
        )*
    };
}

integer_json!(u8, u16, u32, u64, usize, i8, i16, i32, i64, isize);

impl ToJson for f64 {
    fn to_json(&self) -> Result<Value, String> {
        if self.is_finite() {
            Ok(Value::Number(*self))
        } else {
            Err("JSON numbers must be finite".to_owned())
        }
    }
}

impl ToJson for f32 {
    fn to_json(&self) -> Result<Value, String> {
        (*self as f64).to_json()
    }
}

impl<T: ToJson> ToJson for Vec<T> {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.iter()
                .map(ToJson::to_json)
                .collect::<Result<Vec<_>, _>>()?,
        ))
    }
}

impl<T: ToJson> ToJson for BTreeMap<String, T> {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::Object(
            self.iter()
                .map(|(key, value)| Ok((key.clone(), value.to_json()?)))
                .collect::<Result<Map, String>>()?,
        ))
    }
}

impl ToJson for Path {
    fn to_json(&self) -> Result<Value, String> {
        Ok(Value::String(self.to_string_lossy().into_owned()))
    }
}

impl ToJson for PathBuf {
    fn to_json(&self) -> Result<Value, String> {
        self.as_path().to_json()
    }
}

pub fn from_str(source: &str) -> Result<Value, String> {
    let mut parser = Parser {
        source: source.as_bytes(),
        offset: 0,
    };
    let value = parser.parse_value()?;
    parser.skip_whitespace();
    if parser.offset != parser.source.len() {
        return Err(format!("unexpected JSON token at byte {}", parser.offset));
    }
    Ok(value)
}

pub fn to_vec(value: &Value) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    write_value(value, &mut output, None, 0)?;
    Ok(output.into_bytes())
}

pub fn to_vec_pretty(value: &Value) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    write_value(value, &mut output, Some(2), 0)?;
    Ok(output.into_bytes())
}

fn write_value(
    value: &Value,
    output: &mut String,
    pretty_indent: Option<usize>,
    depth: usize,
) -> Result<(), String> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            if !value.is_finite() {
                return Err("JSON numbers must be finite".to_owned());
            }
            if *value == 0.0 && value.is_sign_negative() {
                output.push_str("-0.0");
            } else if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
                output.push_str(&format!("{value:.0}"));
            } else {
                output.push_str(&python_compatible_float(*value)?);
            }
        }
        Value::String(value) => write_string(value, output),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                if let Some(indent) = pretty_indent {
                    output.push('\n');
                    output.push_str(&" ".repeat((depth + 1) * indent));
                }
                write_value(value, output, pretty_indent, depth + 1)?;
            }
            if !values.is_empty()
                && let Some(indent) = pretty_indent
            {
                output.push('\n');
                output.push_str(&" ".repeat(depth * indent));
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            for (index, (key, value)) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                if let Some(indent) = pretty_indent {
                    output.push('\n');
                    output.push_str(&" ".repeat((depth + 1) * indent));
                }
                write_string(key, output);
                output.push(':');
                if pretty_indent.is_some() {
                    output.push(' ');
                }
                write_value(value, output, pretty_indent, depth + 1)?;
            }
            if !values.is_empty()
                && let Some(indent) = pretty_indent
            {
                output.push('\n');
                output.push_str(&" ".repeat(depth * indent));
            }
            output.push('}');
        }
    }
    Ok(())
}

/// Render a binary64 value with the same fixed/scientific cut-over used by
/// CPython's shortest-round-trip `repr(float)`.
///
/// Rust and Python use equivalent shortest-round-trip digits, but Rust keeps
/// `1e-8` in fixed notation while Python writes `1e-08`.  The plate spec is
/// independently parsed and canonicalized by both bakers, so that cosmetic
/// difference would otherwise give semantically identical specs different
/// byte identities.  Normalizing here keeps the N-version evidence literal
/// without weakening the exact canonical-input comparison.
fn python_compatible_float(value: f64) -> Result<String, String> {
    let shortest = value.to_string();
    let negative = shortest.starts_with('-');
    let unsigned = shortest.strip_prefix('-').unwrap_or(&shortest);
    let (coefficient, explicit_exponent) = match unsigned.split_once(['e', 'E']) {
        Some((coefficient, exponent)) => (
            coefficient,
            exponent
                .parse::<i32>()
                .map_err(|_| format!("invalid finite float exponent: {shortest}"))?,
        ),
        None => (unsigned, 0),
    };
    let (integer, fraction) = coefficient
        .split_once('.')
        .map_or((coefficient, ""), |parts| parts);
    let mut digits = format!("{integer}{fraction}");
    let leading_zero_count = digits.bytes().take_while(|byte| *byte == b'0').count();
    digits.drain(..leading_zero_count);
    if digits.is_empty() {
        return Ok(if negative {
            "-0.0".to_owned()
        } else {
            "0.0".to_owned()
        });
    }
    let integer_digit_count = integer.len() as i32;
    let decimal_exponent = explicit_exponent + integer_digit_count - leading_zero_count as i32 - 1;
    while digits.ends_with('0') {
        digits.pop();
    }
    let sign = if negative { "-" } else { "" };
    if !(-4..16).contains(&decimal_exponent) {
        let mut mantissa = digits[..1].to_owned();
        if digits.len() > 1 {
            mantissa.push('.');
            mantissa.push_str(&digits[1..]);
        }
        let exponent_sign = if decimal_exponent >= 0 { '+' } else { '-' };
        return Ok(format!(
            "{sign}{mantissa}e{exponent_sign}{:02}",
            decimal_exponent.abs()
        ));
    }
    let decimal_position = decimal_exponent + 1;
    let body = if decimal_position <= 0 {
        format!("0.{}{}", "0".repeat((-decimal_position) as usize), digits)
    } else if decimal_position as usize >= digits.len() {
        format!(
            "{}{}",
            digits,
            "0".repeat(decimal_position as usize - digits.len())
        )
    } else {
        format!(
            "{}.{}",
            &digits[..decimal_position as usize],
            &digits[decimal_position as usize..]
        )
    };
    Ok(format!("{sign}{body}"))
}

fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{0008}' => output.push_str("\\b"),
            '\u{000c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character <= '\u{001f}' => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

struct Parser<'a> {
    source: &'a [u8],
    offset: usize,
}

impl Parser<'_> {
    fn parse_value(&mut self) -> Result<Value, String> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'n') => {
                self.expect_literal(b"null")?;
                Ok(Value::Null)
            }
            Some(b't') => {
                self.expect_literal(b"true")?;
                Ok(Value::Bool(true))
            }
            Some(b'f') => {
                self.expect_literal(b"false")?;
                Ok(Value::Bool(false))
            }
            Some(b'"') => Ok(Value::String(self.parse_string()?)),
            Some(b'[') => self.parse_array(),
            Some(b'{') => self.parse_object(),
            Some(b'-' | b'0'..=b'9') => self.parse_number(),
            Some(value) => Err(format!(
                "unexpected JSON byte {value:#x} at {}",
                self.offset
            )),
            None => Err("unexpected end of JSON input".to_owned()),
        }
    }

    fn parse_array(&mut self) -> Result<Value, String> {
        self.offset += 1;
        let mut values = Vec::new();
        self.skip_whitespace();
        if self.consume(b']') {
            return Ok(Value::Array(values));
        }
        loop {
            values.push(self.parse_value()?);
            self.skip_whitespace();
            if self.consume(b']') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(Value::Array(values))
    }

    fn parse_object(&mut self) -> Result<Value, String> {
        self.offset += 1;
        let mut values = Map::new();
        self.skip_whitespace();
        if self.consume(b'}') {
            return Ok(Value::Object(values));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(format!(
                    "JSON object key must be a string at {}",
                    self.offset
                ));
            }
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(b':')?;
            let value = self.parse_value()?;
            if values.insert(key.clone(), value).is_some() {
                return Err(format!("duplicate JSON object key {key:?}"));
            }
            self.skip_whitespace();
            if self.consume(b'}') {
                break;
            }
            self.expect(b',')?;
        }
        Ok(Value::Object(values))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut output = String::new();
        let mut segment_start = self.offset;
        while let Some(byte) = self.peek() {
            match byte {
                b'"' => {
                    output.push_str(self.utf8_segment(segment_start, self.offset)?);
                    self.offset += 1;
                    return Ok(output);
                }
                b'\\' => {
                    output.push_str(self.utf8_segment(segment_start, self.offset)?);
                    self.offset += 1;
                    let escaped = self
                        .peek()
                        .ok_or_else(|| "truncated JSON escape".to_owned())?;
                    self.offset += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => output.push(self.parse_unicode_escape()?),
                        _ => return Err("unsupported JSON escape".to_owned()),
                    }
                    segment_start = self.offset;
                }
                0x00..=0x1f => {
                    return Err("unescaped control character in JSON string".to_owned());
                }
                _ => self.offset += 1,
            }
        }
        Err("unterminated JSON string".to_owned())
    }

    fn parse_unicode_escape(&mut self) -> Result<char, String> {
        let first = self.parse_hex_u16()?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.source.get(self.offset..self.offset + 2) != Some(b"\\u") {
                return Err("high surrogate is not followed by a low surrogate".to_owned());
            }
            self.offset += 2;
            let second = self.parse_hex_u16()?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err("invalid low surrogate".to_owned());
            }
            0x1_0000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err("unexpected low surrogate".to_owned());
        } else {
            u32::from(first)
        };
        char::from_u32(scalar).ok_or_else(|| "invalid Unicode scalar".to_owned())
    }

    fn parse_hex_u16(&mut self) -> Result<u16, String> {
        let bytes = self
            .source
            .get(self.offset..self.offset + 4)
            .ok_or_else(|| "truncated Unicode escape".to_owned())?;
        self.offset += 4;
        let text = std::str::from_utf8(bytes).map_err(|_| "invalid Unicode escape".to_owned())?;
        u16::from_str_radix(text, 16).map_err(|_| "invalid Unicode escape".to_owned())
    }

    fn parse_number(&mut self) -> Result<Value, String> {
        let start = self.offset;
        self.consume(b'-');
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => {
                self.offset += 1;
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.offset += 1;
                }
            }
            _ => return Err(format!("invalid JSON number at {start}")),
        }
        if self.consume(b'.') {
            let digit_start = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == digit_start {
                return Err("JSON fraction requires digits".to_owned());
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.offset += 1;
            }
            let digit_start = self.offset;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if self.offset == digit_start {
                return Err("JSON exponent requires digits".to_owned());
            }
        }
        let text = std::str::from_utf8(&self.source[start..self.offset])
            .map_err(|_| "JSON number is not UTF-8".to_owned())?;
        let value = text
            .parse::<f64>()
            .map_err(|_| format!("invalid JSON number {text:?}"))?;
        if !value.is_finite() {
            return Err("JSON number must be finite".to_owned());
        }
        Ok(Value::Number(value))
    }

    fn utf8_segment(&self, start: usize, end: usize) -> Result<&str, String> {
        std::str::from_utf8(&self.source[start..end])
            .map_err(|_| "JSON string is not valid UTF-8".to_owned())
    }

    fn expect_literal(&mut self, value: &[u8]) -> Result<(), String> {
        if self.source.get(self.offset..self.offset + value.len()) == Some(value) {
            self.offset += value.len();
            Ok(())
        } else {
            Err(format!("invalid JSON literal at {}", self.offset))
        }
    }

    fn expect(&mut self, value: u8) -> Result<(), String> {
        self.skip_whitespace();
        if self.consume(value) {
            Ok(())
        } else {
            Err(format!("expected JSON byte {value:#x} at {}", self.offset))
        }
    }

    fn consume(&mut self, value: u8) -> bool {
        if self.peek() == Some(value) {
            self.offset += 1;
            true
        } else {
            false
        }
    }

    fn peek(&self) -> Option<u8> {
        self.source.get(self.offset).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.offset += 1;
        }
    }
}

#[macro_export]
macro_rules! json {
    ($($json:tt)+) => {
        $crate::json_internal!($($json)+)
    };
}

#[macro_export]
#[doc(hidden)]
macro_rules! json_internal {
    (@array [$($elems:expr,)*]) => {
        vec![$($elems,)*]
    };
    (@array [$($elems:expr),*]) => {
        vec![$($elems),*]
    };
    (@array [$($elems:expr,)*] null $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!(null)] $($rest)*)
    };
    (@array [$($elems:expr,)*] true $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!(true)] $($rest)*)
    };
    (@array [$($elems:expr,)*] false $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!(false)] $($rest)*)
    };
    (@array [$($elems:expr,)*] [$($array:tt)*] $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!([$($array)*])] $($rest)*)
    };
    (@array [$($elems:expr,)*] {$($map:tt)*} $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!({$($map)*})] $($rest)*)
    };
    (@array [$($elems:expr,)*] $next:expr, $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!($next),] $($rest)*)
    };
    (@array [$($elems:expr,)*] $last:expr) => {
        $crate::json_internal!(@array [$($elems,)* $crate::json_internal!($last)])
    };
    (@array [$($elems:expr),*] , $($rest:tt)*) => {
        $crate::json_internal!(@array [$($elems,)*] $($rest)*)
    };
    (@array [$($elems:expr),*] $unexpected:tt $($rest:tt)*) => {
        $crate::json_unexpected!($unexpected)
    };

    (@object $object:ident () () ()) => {};
    (@object $object:ident [$($key:tt)+] ($value:expr) , $($rest:tt)*) => {
        let _ = $object.insert(($($key)+).into(), $value);
        $crate::json_internal!(@object $object () ($($rest)*) ($($rest)*));
    };
    (@object $object:ident [$($key:tt)+] ($value:expr) $unexpected:tt $($rest:tt)*) => {
        $crate::json_unexpected!($unexpected);
    };
    (@object $object:ident [$($key:tt)+] ($value:expr)) => {
        let _ = $object.insert(($($key)+).into(), $value);
    };
    (@object $object:ident ($($key:tt)+) (: null $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!(null)) $($rest)*);
    };
    (@object $object:ident ($($key:tt)+) (: true $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!(true)) $($rest)*);
    };
    (@object $object:ident ($($key:tt)+) (: false $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!(false)) $($rest)*);
    };
    (@object $object:ident ($($key:tt)+) (: [$($array:tt)*] $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!([$($array)*])) $($rest)*);
    };
    (@object $object:ident ($($key:tt)+) (: {$($map:tt)*} $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!({$($map)*})) $($rest)*);
    };
    (@object $object:ident ($($key:tt)+) (: $value:expr , $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!($value)) , $($rest)*);
    };
    (@object $object:ident ($($key:tt)+) (: $value:expr) $copy:tt) => {
        $crate::json_internal!(@object $object [$($key)+] ($crate::json_internal!($value)));
    };
    (@object $object:ident ($($key:tt)+) (:) $copy:tt) => {
        $crate::json_internal!();
    };
    (@object $object:ident ($($key:tt)+) () $copy:tt) => {
        $crate::json_internal!();
    };
    (@object $object:ident () (: $($rest:tt)*) ($colon:tt $($copy:tt)*)) => {
        $crate::json_unexpected!($colon);
    };
    (@object $object:ident ($($key:tt)*) (, $($rest:tt)*) ($comma:tt $($copy:tt)*)) => {
        $crate::json_unexpected!($comma);
    };
    (@object $object:ident () (($key:expr) : $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object ($key) (: $($rest)*) (: $($rest)*));
    };
    (@object $object:ident ($($key:tt)*) (: $($unexpected:tt)+) $copy:tt) => {
        $crate::json_expect_expr_comma!($($unexpected)+);
    };
    (@object $object:ident ($($key:tt)*) ($tt:tt $($rest:tt)*) $copy:tt) => {
        $crate::json_internal!(@object $object ($($key)* $tt) ($($rest)*) ($($rest)*));
    };

    (null) => { $crate::json::Value::Null };
    (true) => { $crate::json::Value::Bool(true) };
    (false) => { $crate::json::Value::Bool(false) };
    ([]) => { $crate::json::Value::Array(vec![]) };
    ([ $($tt:tt)+ ]) => {
        $crate::json::Value::Array($crate::json_internal!(@array [] $($tt)+))
    };
    ({}) => { $crate::json::Value::Object($crate::json::Map::new()) };
    ({ $($tt:tt)+ }) => {
        $crate::json::Value::Object({
            let mut object = $crate::json::Map::new();
            $crate::json_internal!(@object object () ($($tt)+) ($($tt)+));
            object
        })
    };
    ($other:expr) => {
        $crate::json::to_value(&$other).expect("json! value conversion")
    };
}

#[macro_export]
#[doc(hidden)]
macro_rules! json_unexpected {
    () => {};
}

#[macro_export]
#[doc(hidden)]
macro_rules! json_expect_expr_comma {
    ($e:expr , $($tt:tt)*) => {};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_nested_json() {
        let value = from_str("{\"a\":[1,true,\"한글\"],\"b\":null}").expect("parse");
        assert_eq!(
            String::from_utf8(to_vec(&value).expect("serialize")).expect("UTF-8"),
            "{\"a\":[1,true,\"한글\"],\"b\":null}"
        );
    }

    #[test]
    fn macro_builds_values() {
        let count = 2;
        assert_eq!(
            json!({"count": count, "items": [true, "x"]})
                .get("count")
                .and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn canonical_float_notation_matches_python_cut_over() {
        for (value, expected) in [
            (0.00014, "0.00014"),
            (0.00001, "1e-05"),
            (0.00000001, "1e-08"),
            (-0.00000001, "-1e-08"),
            (12.345, "12.345"),
        ] {
            assert_eq!(
                String::from_utf8(to_vec(&Value::Number(value)).expect("serialize"))
                    .expect("UTF-8"),
                expected
            );
        }
    }
}
