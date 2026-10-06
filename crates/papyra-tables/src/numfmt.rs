//! Excel number formats: `#,##0.00`, `0%`, `d-mmm-yy`, `[Red](#,##0)` and the rest.
//!
//! A format is up to four `;`-separated sections — positive, negative, zero, text —
//! each a run of digit placeholders, literals and date tokens. It is parsed once per
//! distinct format code and applied per cell. SheetJS's SSF is the reference for the
//! behaviour; this is a much smaller reimplementation of the parts real files use.
//!
//! Formatting is English-only. A locale tag such as `[$-407]` is read and ignored, so
//! a German workbook's dates show English month names, and the locale-dependent
//! built-in formats (14, the short date) take their en-US form.

use crate::cell::general;

/// A formatted value, and the colour a `[Red]`-style section asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct Formatted {
  pub text: String,
  /// `0xRRGGBB`.
  pub color: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Placeholder {
  /// `0`: a digit, or a zero.
  Zero,
  /// `#`: a digit, or nothing.
  Hash,
  /// `?`: a digit, or a space — for aligning decimal points down a column.
  Space,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Unit {
  Hours,
  Minutes,
  Seconds,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
  Lit(String),
  Digit(Placeholder),
  Point,
  Comma,
  Percent,
  /// `E+` shows the exponent's sign always; `E-` only when negative.
  Exp {
    plus: bool,
  },
  Slash,
  /// A fixed fraction denominator, as in `# ?/8`.
  Denom(u32),
  Text,
  General,
  Year(usize),
  Month(usize),
  Minute(usize),
  Day(usize),
  Hour(usize),
  Second(usize),
  /// Digits of fractional seconds: `ss.00` is 2.
  SubSecond(usize),
  /// `AM/PM`, or `A/P` when `short`.
  AmPm {
    short: bool,
  },
  /// `[h]`, `[mm]`, `[ss]`: a duration that does not wrap at the next unit up.
  Elapsed(Unit, usize),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Cmp {
  Lt,
  Le,
  Gt,
  Ge,
  Eq,
  Ne,
}

#[derive(Debug, Clone, PartialEq)]
struct Section {
  toks: Vec<Tok>,
  color: Option<u32>,
  cond: Option<(Cmp, f64)>,
  date: bool,
  twelve_hour: bool,
}

/// A parsed number format.
#[derive(Debug, Clone, PartialEq)]
pub struct NumberFormat {
  sections: Vec<Section>,
}

/// The format code for a built-in id, which a file references without spelling out.
///
/// Ids 5–8 and 14 are locale-dependent in Excel; these are the en-US forms.
pub fn builtin(id: u32) -> Option<&'static str> {
  Some(match id {
    0 => "General",
    1 => "0",
    2 => "0.00",
    3 => "#,##0",
    4 => "#,##0.00",
    5 => "$#,##0_);($#,##0)",
    6 => "$#,##0_);[Red]($#,##0)",
    7 => "$#,##0.00_);($#,##0.00)",
    8 => "$#,##0.00_);[Red]($#,##0.00)",
    9 => "0%",
    10 => "0.00%",
    11 => "0.00E+00",
    12 => "# ?/?",
    13 => "# ??/??",
    14 => "m/d/yyyy",
    15 => "d-mmm-yy",
    16 => "d-mmm",
    17 => "mmm-yy",
    18 => "h:mm AM/PM",
    19 => "h:mm:ss AM/PM",
    20 => "h:mm",
    21 => "h:mm:ss",
    22 => "m/d/yyyy h:mm",
    37 => "#,##0 ;(#,##0)",
    38 => "#,##0 ;[Red](#,##0)",
    39 => "#,##0.00;(#,##0.00)",
    40 => "#,##0.00;[Red](#,##0.00)",
    41 => r#"_(* #,##0_);_(* \(#,##0\);_(* "-"_);_(@_)"#,
    42 => r#"_("$"* #,##0_);_("$"* \(#,##0\);_("$"* "-"_);_(@_)"#,
    43 => r#"_(* #,##0.00_);_(* \(#,##0.00\);_(* "-"??_);_(@_)"#,
    44 => r#"_("$"* #,##0.00_);_("$"* \(#,##0.00\);_("$"* "-"??_);_(@_)"#,
    45 => "mm:ss",
    46 => "[h]:mm:ss",
    47 => "mm:ss.0",
    48 => "##0.0E+0",
    49 => "@",
    _ => return None,
  })
}

const MONTHS: [&str; 12] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS: [&str; 7] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

impl NumberFormat {
  pub fn parse(code: &str) -> Self {
    let sections = split_sections(code)
      .iter()
      .map(|s| parse_section(s))
      .collect();
    Self { sections }
  }

  /// `General`, the default: the format that formats nothing.
  pub fn is_general(&self) -> bool {
    matches!(self.sections.as_slice(), [s] if s.toks == [Tok::General])
  }

  /// Format a number. `date1904` picks the workbook's epoch for date sections.
  pub fn format(&self, value: f64, date1904: bool) -> Formatted {
    let Some((section, value)) = self.pick(value) else {
      return Formatted {
        text: general(value),
        color: None,
      };
    };
    let text = if section.date {
      format_date(section, value, date1904).unwrap_or_else(|| general(value))
    } else {
      format_number(&section.toks, value)
    };
    Formatted {
      text,
      color: section.color,
    }
  }

  /// Format text through the text section, if the format has one.
  ///
  /// `None` means "show the text as it is", which is what every format without an
  /// `@` section does.
  pub fn format_text(&self, text: &str) -> Option<Formatted> {
    let section = match self.sections.as_slice() {
      [_, _, _, text, ..] => text,
      [only] if only.toks.contains(&Tok::Text) => only,
      _ => return None,
    };
    let mut out = String::new();
    for t in &section.toks {
      match t {
        Tok::Lit(s) => out.push_str(s),
        Tok::Text => out.push_str(text),
        _ => {}
      }
    }
    Some(Formatted {
      text: out,
      color: section.color,
    })
  }

  /// The section for `value`, and the value as that section should render it — a
  /// negative section draws its own sign, so it gets the magnitude.
  fn pick(&self, value: f64) -> Option<(&Section, f64)> {
    // A section that only formats text never formats a number.
    let numeric: Vec<&Section> = self
      .sections
      .iter()
      .take(3)
      .filter(|s| !(s.toks.contains(&Tok::Text) && !s.toks.iter().any(is_numeric_tok)))
      .collect();
    if numeric.is_empty() {
      return None;
    }

    if numeric.iter().any(|s| s.cond.is_some()) {
      // Conditions are tested in order; the first section without one is the
      // fallback. Excel keeps the sign here unless the condition implies it.
      for s in &numeric {
        match s.cond {
          Some((cmp, bound)) if test(cmp, value, bound) => {
            let implies_negative = matches!(cmp, Cmp::Lt | Cmp::Le) && bound <= 0.0;
            return Some((s, if implies_negative { value.abs() } else { value }));
          }
          Some(_) => {}
          None => return Some((s, value)),
        }
      }
      return numeric.last().map(|s| (*s, value));
    }

    Some(match numeric.as_slice() {
      [one] => (*one, value),
      [pos, neg] => {
        if value < 0.0 {
          (*neg, -value)
        } else {
          (*pos, value)
        }
      }
      [pos, neg, zero, ..] => {
        if value == 0.0 {
          (*zero, value)
        } else if value < 0.0 {
          (*neg, -value)
        } else {
          (*pos, value)
        }
      }
      [] => return None,
    })
  }
}

fn is_numeric_tok(t: &Tok) -> bool {
  !matches!(t, Tok::Lit(_) | Tok::Text)
}

fn test(cmp: Cmp, v: f64, bound: f64) -> bool {
  match cmp {
    Cmp::Lt => v < bound,
    Cmp::Le => v <= bound,
    Cmp::Gt => v > bound,
    Cmp::Ge => v >= bound,
    Cmp::Eq => v == bound,
    Cmp::Ne => v != bound,
  }
}

/// Split on `;`, except inside quotes, brackets, or after a backslash.
fn split_sections(code: &str) -> Vec<String> {
  let mut out = vec![String::new()];
  let mut chars = code.chars();
  let mut quoted = false;
  let mut bracket = false;
  while let Some(c) = chars.next() {
    let current = out.last_mut().expect("never empty");
    match c {
      '"' if !bracket => quoted = !quoted,
      '[' if !quoted => bracket = true,
      ']' if !quoted => bracket = false,
      '\\' if !quoted => {
        current.push(c);
        if let Some(next) = chars.next() {
          current.push(next);
        }
        continue;
      }
      ';' if !quoted && !bracket => {
        out.push(String::new());
        continue;
      }
      _ => {}
    }
    current.push(c);
  }
  out
}

fn named_color(name: &str) -> Option<u32> {
  Some(match name.to_ascii_lowercase().as_str() {
    "black" => 0x000000,
    "blue" => 0x0000FF,
    "cyan" => 0x00FFFF,
    "green" => 0x00FF00,
    "magenta" => 0xFF00FF,
    "red" => 0xFF0000,
    "white" => 0xFFFFFF,
    "yellow" => 0xFFFF00,
    other => {
      let n: usize = other.strip_prefix("color")?.trim().parse().ok()?;
      // `[ColorN]` counts from 1 into the palette after its eight fixed entries.
      return crate::styles::indexed_color(n + 7);
    }
  })
}

fn parse_section(src: &str) -> Section {
  let chars: Vec<char> = src.chars().collect();
  let mut toks: Vec<Tok> = Vec::new();
  let mut color = None;
  let mut cond = None;
  let mut i = 0;

  let run = |i: usize, lower: char| {
    let mut n = 0;
    while chars
      .get(i + n)
      .is_some_and(|c| c.to_ascii_lowercase() == lower)
    {
      n += 1;
    }
    n
  };
  let lit = |toks: &mut Vec<Tok>, s: &str| {
    if let Some(Tok::Lit(prev)) = toks.last_mut() {
      prev.push_str(s);
    } else {
      toks.push(Tok::Lit(s.to_string()));
    }
  };

  while i < chars.len() {
    let c = chars[i];
    match c {
      '"' => {
        let end = chars[i + 1..]
          .iter()
          .position(|&c| c == '"')
          .map_or(chars.len(), |p| i + 1 + p);
        let s: String = chars[i + 1..end].iter().collect();
        lit(&mut toks, &s);
        i = end + 1;
      }
      '\\' => {
        if let Some(&next) = chars.get(i + 1) {
          lit(&mut toks, &next.to_string());
        }
        i += 2;
      }
      // `_x` pads by the width of x; a space is the honest approximation.
      '_' => {
        lit(&mut toks, " ");
        i += 2;
      }
      // `*x` repeats x to fill the column. There is no column width here to fill.
      '*' => i += 2,
      '[' => {
        let end = chars[i + 1..]
          .iter()
          .position(|&c| c == ']')
          .map_or(chars.len(), |p| i + 1 + p);
        let inner: String = chars[i + 1..end].iter().collect();
        bracket(&inner, &mut toks, &mut color, &mut cond);
        i = end + 1;
      }
      '0' => {
        toks.push(Tok::Digit(Placeholder::Zero));
        i += 1;
      }
      '#' => {
        toks.push(Tok::Digit(Placeholder::Hash));
        i += 1;
      }
      '?' => {
        toks.push(Tok::Digit(Placeholder::Space));
        i += 1;
      }
      '.' => {
        let after_seconds = toks
          .iter()
          .rev()
          .find(|t| !matches!(t, Tok::Lit(_)))
          .is_some_and(|t| matches!(t, Tok::Second(_) | Tok::Elapsed(Unit::Seconds, _)));
        let zeros = run(i + 1, '0');
        if after_seconds && zeros > 0 {
          toks.push(Tok::SubSecond(zeros));
          i += 1 + zeros;
        } else {
          toks.push(Tok::Point);
          i += 1;
        }
      }
      ',' => {
        toks.push(Tok::Comma);
        i += 1;
      }
      '%' => {
        toks.push(Tok::Percent);
        i += 1;
      }
      'E' | 'e' if matches!(chars.get(i + 1), Some('+' | '-')) => {
        toks.push(Tok::Exp {
          plus: chars[i + 1] == '+',
        });
        i += 2;
      }
      '/' if matches!(toks.last(), Some(Tok::Digit(_))) => {
        toks.push(Tok::Slash);
        i += 1;
        if chars.get(i).is_some_and(|c| ('1'..='9').contains(c)) {
          let mut n = 0u32;
          while let Some(d) = chars.get(i).and_then(|c| c.to_digit(10)) {
            n = n.saturating_mul(10).saturating_add(d);
            i += 1;
          }
          toks.push(Tok::Denom(n));
        }
      }
      '@' => {
        toks.push(Tok::Text);
        i += 1;
      }
      'G' | 'g'
        if src[char_offset(src, i)..]
          .to_ascii_lowercase()
          .starts_with("general") =>
      {
        toks.push(Tok::General);
        i += 7;
      }
      'A' | 'a' if upper_at(&chars, i, "AM/PM") => {
        toks.push(Tok::AmPm { short: false });
        i += 5;
      }
      'A' | 'a' if upper_at(&chars, i, "A/P") => {
        toks.push(Tok::AmPm { short: true });
        i += 3;
      }
      'y' | 'Y' => {
        let n = run(i, 'y');
        toks.push(Tok::Year(n));
        i += n;
      }
      'm' | 'M' => {
        let n = run(i, 'm');
        toks.push(Tok::Month(n));
        i += n;
      }
      'd' | 'D' => {
        let n = run(i, 'd');
        toks.push(Tok::Day(n));
        i += n;
      }
      'h' | 'H' => {
        let n = run(i, 'h');
        toks.push(Tok::Hour(n));
        i += n;
      }
      's' | 'S' => {
        let n = run(i, 's');
        toks.push(Tok::Second(n));
        i += n;
      }
      _ => {
        lit(&mut toks, &c.to_string());
        i += 1;
      }
    }
  }

  // `m` is a month unless it sits between hours and seconds, where it is minutes.
  for k in 0..toks.len() {
    if let Tok::Month(n) = toks[k] {
      let before = toks[..k].iter().rev().find(|t| !matches!(t, Tok::Lit(_)));
      let after = toks[k + 1..].iter().find(|t| !matches!(t, Tok::Lit(_)));
      let minutes = matches!(before, Some(Tok::Hour(_) | Tok::Elapsed(Unit::Hours, _)))
        || matches!(after, Some(Tok::Second(_) | Tok::Elapsed(Unit::Seconds, _)));
      if minutes && n <= 2 {
        toks[k] = Tok::Minute(n);
      }
    }
  }

  let date = toks.iter().any(|t| {
    matches!(
      t,
      Tok::Year(_)
        | Tok::Month(_)
        | Tok::Minute(_)
        | Tok::Day(_)
        | Tok::Hour(_)
        | Tok::Second(_)
        | Tok::Elapsed(..)
    )
  });
  let twelve_hour = toks.iter().any(|t| matches!(t, Tok::AmPm { .. }));
  Section {
    toks,
    color,
    cond,
    date,
    twelve_hour,
  }
}

fn char_offset(s: &str, chars: usize) -> usize {
  s.char_indices().nth(chars).map_or(s.len(), |(i, _)| i)
}

fn upper_at(chars: &[char], i: usize, word: &str) -> bool {
  word.chars().enumerate().all(|(k, w)| {
    chars
      .get(i + k)
      .is_some_and(|c| c.to_ascii_uppercase() == w)
  })
}

fn bracket(
  inner: &str,
  toks: &mut Vec<Tok>,
  color: &mut Option<u32>,
  cond: &mut Option<(Cmp, f64)>,
) {
  if let Some(currency) = inner.strip_prefix('$') {
    // `[$€-407]`: a symbol, then a locale id. Only the symbol is shown.
    let symbol = currency.split('-').next().unwrap_or("");
    if !symbol.is_empty() {
      toks.push(Tok::Lit(symbol.to_string()));
    }
    return;
  }
  for (prefix, cmp) in [
    ("<=", Cmp::Le),
    (">=", Cmp::Ge),
    ("<>", Cmp::Ne),
    ("<", Cmp::Lt),
    (">", Cmp::Gt),
    ("=", Cmp::Eq),
  ] {
    if let Some(n) = inner.strip_prefix(prefix) {
      if let Ok(n) = n.trim().parse() {
        *cond = Some((cmp, n));
      }
      return;
    }
  }
  if let Some(c) = named_color(inner) {
    *color = Some(c);
    return;
  }
  let lower = inner.to_ascii_lowercase();
  let unit = match lower.chars().next() {
    Some('h') => Unit::Hours,
    Some('m') => Unit::Minutes,
    Some('s') => Unit::Seconds,
    _ => return,
  };
  if lower.chars().all(|c| c == lower.as_bytes()[0] as char) {
    toks.push(Tok::Elapsed(unit, lower.len()));
  }
}

// ------------------------------------------------------------------- numbers

/// `value` rounded to `places` decimals, as integer and fraction digit strings.
///
/// Rounds the decimal expansion at 15 significant digits — what Excel stores — and
/// then half away from zero, as Excel does, rather than rounding the binary value:
/// `2.675` is `2.67499999…` in binary and Excel shows `2.68`.
fn round_decimal(value: f64, places: usize) -> (String, String) {
  let value = value.abs();
  if value == 0.0 || !value.is_finite() {
    return (String::new(), "0".repeat(places));
  }
  let sci = format!("{value:.14e}");
  let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
  let exp: i64 = exp.parse().unwrap_or(0);
  let digits: Vec<u8> = mantissa
    .bytes()
    .filter(u8::is_ascii_digit)
    .map(|b| b - b'0')
    .collect();
  // `digits` represents d.dddd × 10^exp; the decimal point sits after index `exp`.
  let point = exp + 1;
  let keep = point + places as i64;
  let mut kept: Vec<u8> = if keep <= 0 {
    Vec::new()
  } else {
    (0..keep as usize)
      .map(|k| *digits.get(k).unwrap_or(&0))
      .collect()
  };
  let next = if keep < 0 {
    0
  } else {
    *digits.get(keep as usize).unwrap_or(&0)
  };
  let mut point = point;
  if next >= 5 {
    // Carry.
    let mut k = kept.len();
    loop {
      if k == 0 {
        kept.insert(0, 1);
        point += 1;
        break;
      }
      k -= 1;
      if kept[k] == 9 {
        kept[k] = 0;
      } else {
        kept[k] += 1;
        break;
      }
    }
  }
  // `kept` now holds the digits from the first significant one; a value below 1
  // needs zeros in front to fill the integer part and the leading decimals.
  let total = point.max(0) + places as i64;
  while (kept.len() as i64) < total {
    kept.insert(0, 0);
  }
  let split = kept.len() as i64 - places as i64;
  let int: String = kept[..split.max(0) as usize]
    .iter()
    .map(|d| char::from(b'0' + d))
    .collect();
  let frac: String = kept[split.max(0) as usize..]
    .iter()
    .map(|d| char::from(b'0' + d))
    .collect();
  (int.trim_start_matches('0').to_string(), frac)
}

fn group(digits: &str) -> String {
  let mut out = String::with_capacity(digits.len() + digits.len() / 3);
  for (k, c) in digits.chars().enumerate() {
    if k > 0 && (digits.len() - k).is_multiple_of(3) {
      out.push(',');
    }
    out.push(c);
  }
  out
}

fn placeholder_fill(p: Placeholder) -> &'static str {
  match p {
    Placeholder::Zero => "0",
    Placeholder::Hash => "",
    Placeholder::Space => " ",
  }
}

/// Lay `digits` into `holders` right to left; the leftmost takes any overflow.
fn fill_right(holders: &[Placeholder], digits: &str) -> Vec<String> {
  let n = holders.len();
  let d: Vec<char> = digits.chars().collect();
  let mut out = vec![String::new(); n];
  for k in (0..n).rev() {
    let from_end = n - k;
    if k == 0 && d.len() >= from_end {
      out[k] = d[..=d.len() - from_end].iter().collect();
    } else if d.len() >= from_end {
      out[k] = d[d.len() - from_end].to_string();
    } else {
      out[k] = placeholder_fill(holders[k]).to_string();
    }
  }
  out
}

fn format_number(toks: &[Tok], value: f64) -> String {
  let negative = value < 0.0;
  let mut value = value.abs();

  if toks.contains(&Tok::General) {
    let mut out = String::new();
    for t in toks {
      match t {
        Tok::Lit(s) => out.push_str(s),
        Tok::General => out.push_str(&general(value)),
        _ => {}
      }
    }
    return signed(negative, out);
  }

  if let Some(slash) = toks.iter().position(|t| *t == Tok::Slash) {
    return signed(negative, format_fraction(toks, slash, value));
  }

  let exp_at = toks.iter().position(|t| matches!(t, Tok::Exp { .. }));
  let mantissa_end = exp_at.unwrap_or(toks.len());
  let point_at = toks[..mantissa_end].iter().position(|t| *t == Tok::Point);
  let int_end = point_at.unwrap_or(mantissa_end);

  let digit_positions = |range: std::ops::Range<usize>| -> Vec<usize> {
    range
      .filter(|&k| matches!(toks[k], Tok::Digit(_)))
      .collect()
  };
  let int_holders = digit_positions(0..int_end);
  let frac_holders = point_at.map_or_else(Vec::new, |p| digit_positions(p + 1..mantissa_end));

  // A comma between integer placeholders groups thousands; commas straight after
  // the last placeholder each divide by a thousand.
  let first_int = int_holders.first().copied();
  let last_digit = int_holders.last().max(frac_holders.last()).copied();
  let mut grouping = false;
  let mut scale_commas = Vec::new();
  for (k, t) in toks[..mantissa_end].iter().enumerate() {
    if *t != Tok::Comma {
      continue;
    }
    let digit_after = toks[k + 1..int_end.max(k + 1)]
      .iter()
      .any(|t| matches!(t, Tok::Digit(_)));
    if first_int.is_some_and(|f| f < k) && digit_after {
      grouping = true;
    } else if last_digit.is_some_and(|l| l < k) {
      scale_commas.push(k);
    }
  }
  value /= 1000f64.powi(scale_commas.len() as i32);
  value *= 100f64.powi(toks.iter().filter(|t| **t == Tok::Percent).count() as i32);

  let mut exponent = 0i32;
  if exp_at.is_some() && value != 0.0 {
    let int_count = int_holders.len().max(1) as i32;
    let engineering =
      int_count > 1 && first_int.is_some_and(|f| toks[f] == Tok::Digit(Placeholder::Hash));
    let e = value.log10().floor() as i32;
    exponent = if engineering {
      e.div_euclid(int_count) * int_count
    } else {
      e - (int_count - 1)
    };
    value /= 10f64.powi(exponent);
    // Rounding can carry the mantissa into another digit: 9.99 → 10.0.
    let (int, _) = round_decimal(value, frac_holders.len());
    if !engineering && int.len() as i32 > int_count {
      exponent += 1;
      value /= 10.0;
    }
  }

  let (int_digits, frac_digits) = round_decimal(value, frac_holders.len());
  let int_text: Vec<String> = if grouping {
    let min = int_holders
      .iter()
      .filter(|&&k| toks[k] == Tok::Digit(Placeholder::Zero))
      .count();
    let padded = format!("{int_digits:0>min$}");
    let mut v = vec![String::new(); int_holders.len()];
    if let Some(first) = v.first_mut() {
      *first = group(&padded);
    }
    v
  } else {
    let holders: Vec<Placeholder> = int_holders.iter().map(|&k| placeholder(&toks[k])).collect();
    fill_right(&holders, &int_digits)
  };

  // Trailing fraction zeros are dropped for `#` and blanked for `?`.
  let frac_chars: Vec<char> = frac_digits.chars().collect();
  let mut frac_text: Vec<String> = frac_chars.iter().map(char::to_string).collect();
  for k in (0..frac_holders.len()).rev() {
    if frac_chars.get(k) != Some(&'0') {
      break;
    }
    match placeholder(&toks[frac_holders[k]]) {
      Placeholder::Zero => break,
      p => frac_text[k] = placeholder_fill(p).to_string(),
    }
  }

  let mut out = String::new();
  let mut int_k = 0;
  let mut frac_k = 0;
  let mut exp_holders = Vec::new();
  for (k, t) in toks.iter().enumerate() {
    if let (Some(e), Tok::Digit(p)) = (exp_at, t)
      && k > e
    {
      exp_holders.push(*p);
      continue;
    }
    match t {
      Tok::Lit(s) => out.push_str(s),
      Tok::Digit(_) if k < int_end => {
        out.push_str(&int_text[int_k]);
        int_k += 1;
      }
      Tok::Digit(_) => {
        out.push_str(frac_text.get(frac_k).map_or("", String::as_str));
        frac_k += 1;
      }
      Tok::Point => out.push('.'),
      Tok::Comma if grouping || scale_commas.contains(&k) => {}
      Tok::Comma => out.push(','),
      Tok::Percent => out.push('%'),
      Tok::Exp { plus } => {
        out.push('E');
        if exponent < 0 {
          out.push('-');
        } else if *plus {
          out.push('+');
        }
        out.push('\u{0}');
      }
      _ => {}
    }
  }
  if exp_at.is_some() {
    let digits = fill_right(&exp_holders, &exponent.unsigned_abs().to_string()).concat();
    out = out.replacen('\u{0}', &digits, 1);
  }
  signed(
    negative && (int_digits.bytes().any(|b| b != b'0') || frac_digits.bytes().any(|b| b != b'0')),
    out,
  )
}

fn signed(negative: bool, text: String) -> String {
  if negative { format!("-{text}") } else { text }
}

fn placeholder(t: &Tok) -> Placeholder {
  match t {
    Tok::Digit(p) => *p,
    _ => Placeholder::Hash,
  }
}

/// `# ?/?`: a whole part (optional), a numerator, a denominator.
fn format_fraction(toks: &[Tok], slash: usize, value: f64) -> String {
  // The numerator is the run of placeholders directly before the slash; anything
  // before that, separated by a literal, is the whole part.
  let mut num_start = slash;
  while num_start > 0 && matches!(toks[num_start - 1], Tok::Digit(_)) {
    num_start -= 1;
  }
  let whole_holders: Vec<usize> = (0..num_start)
    .filter(|&k| matches!(toks[k], Tok::Digit(_)))
    .collect();
  let num_holders: Vec<Placeholder> = toks[num_start..slash].iter().map(placeholder).collect();
  let den_end = toks[slash + 1..]
    .iter()
    .position(|t| !matches!(t, Tok::Digit(_) | Tok::Denom(_)))
    .map_or(toks.len(), |p| slash + 1 + p);
  let den_holders: Vec<Placeholder> = toks[slash + 1..den_end]
    .iter()
    .filter(|t| matches!(t, Tok::Digit(_)))
    .map(placeholder)
    .collect();
  let fixed = toks[slash + 1..den_end].iter().find_map(|t| match t {
    Tok::Denom(d) => Some(*d),
    _ => None,
  });

  let has_whole = !whole_holders.is_empty();
  let mut whole = if has_whole { value.trunc() } else { 0.0 };
  let frac = value - whole;
  let (mut num, den) = match fixed {
    Some(d) => ((frac * f64::from(d)).round() as u64, u64::from(d)),
    None => best_fraction(frac, 10u64.pow(den_holders.len().min(4) as u32) - 1),
  };
  if has_whole && num == den {
    whole += 1.0;
    num = 0;
  }
  let num = if has_whole {
    num
  } else {
    num + (whole as u64) * den
  };

  let whole_text = if has_whole {
    let holders: Vec<Placeholder> = whole_holders
      .iter()
      .map(|&k| placeholder(&toks[k]))
      .collect();
    let digits = if whole == 0.0 {
      String::new()
    } else {
      format!("{whole:.0}")
    };
    fill_right(&holders, &digits)
  } else {
    Vec::new()
  };

  // A whole number with a fraction format shows just the whole number.
  let blank = has_whole && num == 0;
  let mut out = String::new();
  let mut w = 0;
  for (k, t) in toks.iter().enumerate() {
    if (num_start..den_end).contains(&k) {
      if blank {
        continue;
      }
      if k == num_start {
        out.push_str(&fill_right(&num_holders, &num.to_string()).concat());
      } else if k == slash {
        out.push('/');
      } else if k == slash + 1 {
        let d = den.to_string();
        let pad = den_holders.len().saturating_sub(d.len());
        out.push_str(&d);
        out.push_str(&" ".repeat(pad));
      }
      continue;
    }
    match t {
      Tok::Lit(s) => out.push_str(s),
      Tok::Digit(_) => {
        out.push_str(&whole_text[w]);
        w += 1;
      }
      _ => {}
    }
  }
  let out = out.trim_end().to_string();
  if out.trim().is_empty() {
    "0".to_string()
  } else {
    out
  }
}

/// The closest fraction to `x` in [0, 1) with a denominator up to `max_den`.
fn best_fraction(x: f64, max_den: u64) -> (u64, u64) {
  let mut best = (0u64, 1u64);
  let mut err = x;
  for den in 1..=max_den.max(1) {
    let num = (x * den as f64).round();
    let e = (x - num / den as f64).abs();
    if e < err - 1e-12 {
      err = e;
      best = (num as u64, den);
      if e == 0.0 {
        break;
      }
    }
  }
  best
}

// --------------------------------------------------------------------- dates

/// Days since 1970-01-01 to (year, month, day). Howard Hinnant's algorithm.
fn civil(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  let y = yoe + era * 400 + i64::from(m <= 2);
  (y, m, d)
}

struct DateParts {
  year: i64,
  month: u32,
  day: u32,
  weekday: usize,
  hour: u32,
  minute: u32,
  second: u32,
  /// Milliseconds, for `ss.000`.
  millis: u32,
}

/// Break an Excel serial into calendar parts.
///
/// The 1900 system counts 1900-02-29, a day that did not exist — Lotus 1-2-3's bug,
/// kept by Excel for compatibility — so serial 60 is that day and every serial
/// before it is one day off from a plain count.
fn date_parts(serial: f64, date1904: bool, sub_digits: usize) -> Option<DateParts> {
  if !(0.0..2_958_466.0).contains(&serial) {
    return None;
  }
  // Round to the precision shown, so 23:59:59.6 shown to the second is the next day.
  let unit = 10f64.powi(sub_digits.min(3) as i32);
  let total = (serial * 86_400.0 * unit).round() / unit;
  let mut days = (total / 86_400.0).floor() as i64;
  let secs = total - days as f64 * 86_400.0;

  let (year, month, day, weekday);
  if !date1904 && days == 60 {
    (year, month, day) = (1900, 2, 29);
    weekday = 3;
  } else if !date1904 && days == 0 {
    // Excel's "1900-01-00", which a time-only value carries.
    (year, month, day) = (1900, 1, 0);
    weekday = 6;
  } else {
    if !date1904 && days < 60 {
      days += 1;
    }
    let epoch = if date1904 { 24_107 } else { 25_569 };
    let unix = days - epoch;
    (year, month, day) = civil(unix);
    weekday = (unix + 4).rem_euclid(7) as usize;
  }
  let whole = secs.floor();
  Some(DateParts {
    year,
    month,
    day,
    weekday,
    hour: (whole / 3600.0) as u32,
    minute: (whole / 60.0) as u32 % 60,
    second: whole as u32 % 60,
    millis: ((secs - whole) * 1000.0).round() as u32,
  })
}

fn format_date(section: &Section, serial: f64, date1904: bool) -> Option<String> {
  let sub = section
    .toks
    .iter()
    .find_map(|t| match t {
      Tok::SubSecond(n) => Some(*n),
      _ => None,
    })
    .unwrap_or(0);
  let p = date_parts(serial, date1904, sub)?;
  let mut out = String::new();
  for t in &section.toks {
    match *t {
      Tok::Lit(ref s) => out.push_str(s),
      Tok::Year(n) if n <= 2 => out.push_str(&format!("{:02}", p.year.rem_euclid(100))),
      Tok::Year(_) => out.push_str(&format!("{:04}", p.year)),
      Tok::Month(1) => out.push_str(&p.month.to_string()),
      Tok::Month(2) => out.push_str(&format!("{:02}", p.month)),
      Tok::Month(3) => out.push_str(&MONTHS[p.month as usize - 1][..3]),
      Tok::Month(5) => out.push_str(&MONTHS[p.month as usize - 1][..1]),
      Tok::Month(_) => out.push_str(MONTHS[p.month as usize - 1]),
      Tok::Minute(1) => out.push_str(&p.minute.to_string()),
      Tok::Minute(_) => out.push_str(&format!("{:02}", p.minute)),
      Tok::Day(1) => out.push_str(&p.day.to_string()),
      Tok::Day(2) => out.push_str(&format!("{:02}", p.day)),
      Tok::Day(3) => out.push_str(&DAYS[p.weekday][..3]),
      Tok::Day(_) => out.push_str(DAYS[p.weekday]),
      Tok::Hour(n) => {
        let h = if section.twelve_hour {
          match p.hour % 12 {
            0 => 12,
            h => h,
          }
        } else {
          p.hour
        };
        if n == 1 {
          out.push_str(&h.to_string());
        } else {
          out.push_str(&format!("{h:02}"));
        }
      }
      Tok::Second(1) => out.push_str(&p.second.to_string()),
      Tok::Second(_) => out.push_str(&format!("{:02}", p.second)),
      Tok::SubSecond(n) => {
        let ms = format!("{:03}", p.millis);
        out.push('.');
        out.push_str(&ms[..n.min(3)]);
      }
      Tok::AmPm { short } => {
        let am = p.hour < 12;
        out.push_str(match (short, am) {
          (false, true) => "AM",
          (false, false) => "PM",
          (true, true) => "A",
          (true, false) => "P",
        });
      }
      Tok::Elapsed(unit, n) => {
        let seconds = (serial * 86_400.0).round() as i64;
        let v = match unit {
          Unit::Hours => seconds / 3600,
          Unit::Minutes => seconds / 60,
          Unit::Seconds => seconds,
        };
        out.push_str(&format!("{v:0n$}"));
      }
      // Digits and the like in a date format are literal text to Excel.
      Tok::Digit(Placeholder::Zero) => out.push('0'),
      Tok::Point => out.push('.'),
      Tok::Comma => out.push(','),
      Tok::Slash => out.push('/'),
      _ => {}
    }
  }
  Some(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn fmt(code: &str, v: f64) -> String {
    NumberFormat::parse(code).format(v, false).text
  }

  #[test]
  fn plain_and_grouped_numbers() {
    assert_eq!(fmt("0", 3.7), "4");
    assert_eq!(fmt("0.00", std::f64::consts::E), "2.72");
    assert_eq!(fmt("#,##0", 1234567.0), "1,234,567");
    assert_eq!(fmt("#,##0.00", 1234.5), "1,234.50");
    assert_eq!(fmt("#,##0.00", 0.5), "0.50");
    assert_eq!(fmt("#.##", 0.5), ".5");
    assert_eq!(fmt("0.0#", 2.0), "2.0");
    assert_eq!(fmt("000", 7.0), "007");
    assert_eq!(fmt("0", -3.0), "-3");
  }

  #[test]
  fn rounds_the_decimal_not_the_binary() {
    // 2.675 is 2.67499999… as a double; Excel shows 2.68.
    assert_eq!(fmt("0.00", 2.675), "2.68");
    assert_eq!(fmt("0", 0.5), "1");
    assert_eq!(fmt("0", 2.5), "3");
    assert_eq!(fmt("0.0", 9.96), "10.0");
  }

  #[test]
  fn literals_between_placeholders() {
    assert_eq!(fmt("000-00-0000", 123456789.0), "123-45-6789");
    assert_eq!(fmt("(###) ###-####", 5551234567.0), "(555) 123-4567");
  }

  #[test]
  fn sections_colours_and_accounting() {
    let f = NumberFormat::parse("#,##0.00;[Red](#,##0.00)");
    assert_eq!(f.format(-1234.5, false).text, "(1,234.50)");
    assert_eq!(f.format(-1234.5, false).color, Some(0xFF0000));
    assert_eq!(f.format(1234.5, false).color, None);
    let acct = builtin(44).unwrap();
    assert_eq!(fmt(acct, 1234.5), " $1,234.50 ");
    assert_eq!(fmt(acct, -1234.5), " $(1,234.50)");
    assert_eq!(fmt(acct, 0.0), " $-   ");
    assert_eq!(fmt("0;-0;\"zero\"", 0.0), "zero");
  }

  #[test]
  fn percent_scale_and_currency() {
    assert_eq!(fmt("0%", 0.256), "26%");
    assert_eq!(fmt("0.00%", 0.256), "25.60%");
    assert_eq!(fmt("#,##0,\"K\"", 1_234_567.0), "1,235K");
    assert_eq!(fmt("0.0,,\"M\"", 1_234_567.0), "1.2M");
    assert_eq!(fmt("[$€-407] #,##0.00", 1234.5), "€ 1,234.50");
    assert_eq!(fmt("[$-409]0.00", 1.0), "1.00");
  }

  #[test]
  fn conditions() {
    let f = "[>=1000]#,##0,\"K\";0";
    assert_eq!(fmt(f, 2500.0), "3K");
    assert_eq!(fmt(f, 999.0), "999");
  }

  #[test]
  fn scientific() {
    assert_eq!(fmt("0.00E+00", 12345.0), "1.23E+04");
    assert_eq!(fmt("0.00E+00", 0.00012), "1.20E-04");
    assert_eq!(fmt("0.0E-0", 12345.0), "1.2E4");
    assert_eq!(fmt("##0.0E+0", 12345.0), "12.3E+3");
    assert_eq!(fmt("0.00E+00", 9.999), "1.00E+01");
  }

  #[test]
  fn fractions() {
    assert_eq!(fmt("# ?/?", 1.5), "1 1/2");
    // The best fraction under 100 for 0.14159… — 14/99 beats 1/7.
    assert_eq!(fmt("# ??/??", std::f64::consts::PI), "3 14/99");
    assert_eq!(fmt("?/?", 0.75), "3/4");
    assert_eq!(fmt("# ?/8", 2.3), "2 2/8");
    assert_eq!(fmt("# ?/?", 4.0), "4");
  }

  #[test]
  fn dates() {
    // 2024-03-15 13:30 is serial 45366.5625.
    let t = 45366.5625;
    assert_eq!(fmt("yyyy-mm-dd", t), "2024-03-15");
    assert_eq!(fmt("m/d/yyyy", t), "3/15/2024");
    assert_eq!(fmt("d-mmm-yy", t), "15-Mar-24");
    assert_eq!(fmt("dddd, mmmm d", t), "Friday, March 15");
    assert_eq!(fmt("h:mm AM/PM", t), "1:30 PM");
    assert_eq!(fmt("hh:mm:ss", t), "13:30:00");
    assert_eq!(fmt("mmm", t), "Mar");
    assert_eq!(fmt("mmmmm", t), "M");
  }

  #[test]
  fn minutes_versus_months() {
    // `mm` after hours, or before seconds, is minutes.
    assert_eq!(fmt("h:mm", 0.5 + 5.0 / 1440.0), "12:05");
    assert_eq!(fmt("mm:ss", 75.0 / 86_400.0), "01:15");
    assert_eq!(fmt("mm/yy", 45366.0), "03/24");
  }

  #[test]
  fn elapsed_time_and_subseconds() {
    assert_eq!(fmt("[h]:mm:ss", 1.5), "36:00:00");
    assert_eq!(fmt("[mm]:ss", 1.0 / 24.0), "60:00");
    assert_eq!(fmt("mm:ss.0", 1.25 / 86_400.0), "00:01.3");
  }

  #[test]
  fn the_1900_leap_year_bug() {
    assert_eq!(fmt("yyyy-mm-dd", 59.0), "1900-02-28");
    assert_eq!(fmt("yyyy-mm-dd", 60.0), "1900-02-29");
    assert_eq!(fmt("yyyy-mm-dd", 61.0), "1900-03-01");
    assert_eq!(fmt("yyyy-mm-dd", 1.0), "1900-01-01");
    // The 1904 system counts from 1904-01-01 and has no such day.
    assert_eq!(
      NumberFormat::parse("yyyy-mm-dd").format(0.0, true).text,
      "1904-01-01"
    );
  }

  #[test]
  fn text_and_general() {
    let f = NumberFormat::parse("0.00;-0.00;0;\"[\"@\"]\"");
    assert_eq!(f.format_text("hi").unwrap().text, "[hi]");
    assert_eq!(NumberFormat::parse("0.00").format_text("hi"), None);
    assert_eq!(
      NumberFormat::parse("@").format_text("hi").unwrap().text,
      "hi"
    );
    assert!(NumberFormat::parse("General").is_general());
    assert_eq!(fmt("General", 0.1 + 0.2), "0.3");
    assert_eq!(fmt("General\" units\"", 5.0), "5 units");
  }

  #[test]
  fn a_negative_date_falls_back_to_general() {
    assert_eq!(fmt("yyyy-mm-dd", -1.0), "-1");
  }
}
