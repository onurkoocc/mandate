//! The two functions of Node's `node:path` `posix` that `caps.ts` uses,
//! `normalize` and `isAbsolute`, ported from Node's `lib/path.js` with their
//! edge cases: the empty string is `.`, `..` above the root of an absolute
//! path is dropped and kept in a relative one, repeated slashes are one,
//! and one trailing slash is kept.
//!
//! Node works on UTF-16 code units, this on bytes of UTF-8. The two agree:
//! every index the algorithm cuts at is the place of a `/` or `.`, which is
//! one unit in both, and the lengths it compares are compared with 2 only
//! where the text measured is `..` or holds no `/` (see `normalize_string`).

/// `posix.isAbsolute(path)`: whether it starts with `/`.
#[must_use]
pub fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
}

/// `posix.normalize(path)`.
///
/// ```js
/// normalize(path) {
///   if (path.length === 0) return '.';
///   const isAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
///   const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;
///   path = normalizeString(path, !isAbsolute, '/', isPosixPathSeparator);
///   if (path.length === 0) {
///     if (isAbsolute) return '/';
///     return trailingSeparator ? './' : '.';
///   }
///   if (trailingSeparator) path += '/';
///   return isAbsolute ? `/${path}` : path;
/// }
/// ```
#[must_use]
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out = normalize_string(path, !absolute);
    if out.is_empty() {
        return if absolute {
            "/".to_owned()
        } else if trailing {
            "./".to_owned()
        } else {
            ".".to_owned()
        };
    }
    if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// Node's `normalizeString(path, allowAboveRoot, '/', isPosixPathSeparator)`:
/// resolves `.` and `..` segments.
///
/// ```js
/// let res = ''; let lastSegmentLength = 0; let lastSlash = -1; let dots = 0; let code = 0;
/// for (let i = 0; i <= path.length; ++i) {
///   if (i < path.length) code = path.charCodeAt(i);
///   else if (isPathSeparator(code)) break;
///   else code = CHAR_FORWARD_SLASH;
///   if (isPathSeparator(code)) {
///     if (lastSlash === i - 1 || dots === 1) {
///       // NOOP
///     } else if (dots === 2) {
///       if (res.length < 2 || lastSegmentLength !== 2 ||
///           res.charCodeAt(res.length - 1) !== CHAR_DOT || res.charCodeAt(res.length - 2) !== CHAR_DOT) {
///         if (res.length > 2) {
///           const lastSlashIndex = res.lastIndexOf(separator);
///           if (lastSlashIndex === -1) { res = ''; lastSegmentLength = 0; }
///           else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf(separator); }
///           lastSlash = i; dots = 0; continue;
///         } else if (res.length !== 0) {
///           res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
///         }
///       }
///       if (allowAboveRoot) { res += res.length > 0 ? `${separator}..` : '..'; lastSegmentLength = 2; }
///     } else {
///       if (res.length > 0) res += `${separator}${path.slice(lastSlash + 1, i)}`;
///       else res = path.slice(lastSlash + 1, i);
///       lastSegmentLength = i - lastSlash - 1;
///     }
///     lastSlash = i; dots = 0;
///   } else if (code === CHAR_DOT && dots !== -1) {
///     ++dots;
///   } else {
///     dots = -1;
///   }
/// }
/// return res;
/// ```
///
/// Here `start` is `lastSlash + 1`, the start of the current segment, and
/// `dots` is `None` where Node's is -1. Lengths are in bytes: a `res` of at
/// most 2 bytes or of more than 2 bytes with no `/` is emptied by either
/// branch alike, and a segment ending in `..` is 2 bytes long exactly when
/// it is 2 code units long, so the branches taken are Node's.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let bytes = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length: usize = 0;
    let mut start: usize = 0;
    let mut dots: Option<usize> = Some(0);
    let mut code: u8 = 0;
    for i in 0..=bytes.len() {
        if let Some(&c) = bytes.get(i) {
            code = c;
        } else if code == b'/' {
            break;
        } else {
            code = b'/';
        }
        if code == b'/' {
            if start == i || dots == Some(1) {
                // Nothing: an empty segment or `.`.
            } else if dots == Some(2) {
                let ends_in_dots =
                    res.len() >= 2 && last_segment_length == 2 && res.ends_with("..");
                if !ends_in_dots {
                    if res.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(slash) => {
                                res.truncate(slash);
                                last_segment_length = match res.rfind('/') {
                                    Some(j) => res.len().saturating_sub(1).saturating_sub(j),
                                    None => res.len(),
                                };
                            }
                        }
                        start = i.saturating_add(1);
                        dots = Some(0);
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        start = i.saturating_add(1);
                        dots = Some(0);
                        continue;
                    }
                }
                if allow_above_root {
                    res.push_str(if res.is_empty() { ".." } else { "/.." });
                    last_segment_length = 2;
                }
            } else {
                let segment = path.get(start..i).unwrap_or_default();
                if !res.is_empty() {
                    res.push('/');
                }
                res.push_str(segment);
                last_segment_length = i.saturating_sub(start);
            }
            start = i.saturating_add(1);
            dots = Some(0);
        } else if code == b'.' && dots.is_some() {
            dots = dots.map(|d| d.saturating_add(1));
        } else {
            dots = None;
        }
    }
    res
}
