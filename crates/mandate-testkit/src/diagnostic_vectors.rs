//! The diagnostic vectors, `vectors/diagnostics/` (see `vectors/README.md`,
//! "diagnostics/"): the whole result of the TypeScript compiler for every
//! compile case of `conformance/` and for the checks of every golden
//! program, read with `mandate-ir`'s strict reader.

use mandate_ir::Value;

use crate::read_json;

/// The directory of the vectors.
pub const DIAGNOSTICS: &str = "vectors/diagnostics";

/// One stored result of a conformance case: an entry of
/// `conformance-N.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCase {
    /// The case's id, its directory `conformance/<name>/`.
    pub name: String,
    /// The front door the case goes through: `check`, `check_patched`,
    /// `apply_ops`, `check_subprogram` or `check_amendment`.
    pub door: String,
    /// The input file, relative to the case directory; `None` when the
    /// source is the `input.text` of `case.json`.
    pub input_file: Option<String>,
    /// `mdt` or `json`.
    pub input_kind: String,
    /// The module files, relative to the case directory, in order.
    pub modules: Vec<String>,
    /// The lock file, relative to the case directory.
    pub lock: Option<String>,
    /// What the door returns, as a value in the compiler's member order.
    pub result: Option<Value>,
    /// Or its exact text, for a result with a number JSON integers cannot
    /// carry.
    pub text: Option<String>,
}

/// The stored results of one golden program: an entry of `golden-N.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProgram {
    /// The program's repository path.
    pub program: String,
    /// The module files it is given, repository paths, in order.
    pub modules: Vec<String>,
    /// The lock it is checked with, a repository path.
    pub lock: Option<String>,
    /// `check`, `check_module`, `check_lock` and `load`, those it has, as
    /// values.
    pub results: Vec<(String, Value)>,
    /// The results stored as their exact text instead.
    pub texts: Vec<(String, String)>,
}

fn str_of(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("no string member {key}"))
}

fn strings_of(v: &Value, key: &str) -> Result<Vec<String>, String> {
    v.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("no array member {key}"))?
        .iter()
        .map(|x| {
            x.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{key} holds a non-string"))
        })
        .collect()
}

fn nullable(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Every part of `<prefix>-N.json`, the entries under `member`, in order.
fn parts(prefix: &str, member: &str) -> Result<Vec<Value>, String> {
    let first = read_json(&format!("{DIAGNOSTICS}/{prefix}-1.json"))?;
    let n = first
        .get("parts")
        .and_then(Value::as_i64)
        .ok_or("no parts")?;
    let mut out = Vec::new();
    let mut part: i64 = 1;
    while part <= n {
        let file = if part == 1 {
            first.clone()
        } else {
            read_json(&format!("{DIAGNOSTICS}/{prefix}-{part}.json"))?
        };
        out.extend(
            file.get(member)
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{prefix}-{part}.json: no {member}"))?
                .iter()
                .cloned(),
        );
        part = part.saturating_add(1);
    }
    Ok(out)
}

/// The stored results of the conformance cases, by name in UTF-16 order.
///
/// # Errors
///
/// When a file cannot be read or does not have the format.
pub fn stored_cases() -> Result<Vec<StoredCase>, String> {
    parts("conformance", "cases")?
        .iter()
        .map(|c| {
            let input = c.get("input").ok_or("a case without input")?;
            Ok(StoredCase {
                name: str_of(c, "name")?,
                door: str_of(c, "door")?,
                input_file: nullable(input, "file"),
                input_kind: str_of(input, "kind")?,
                modules: strings_of(c, "modules")?,
                lock: nullable(c, "lock"),
                result: c.get("result").cloned(),
                text: nullable(c, "text"),
            })
        })
        .collect()
}

/// The stored results of the golden programs, by program in UTF-16 order.
///
/// # Errors
///
/// When a file cannot be read or does not have the format.
pub fn stored_programs() -> Result<Vec<StoredProgram>, String> {
    parts("golden", "programs")?
        .iter()
        .map(|p| {
            let members = |key: &str| -> Vec<(String, Value)> {
                p.get(key)
                    .and_then(Value::as_object)
                    .map(|o| o.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect())
                    .unwrap_or_default()
            };
            Ok(StoredProgram {
                program: str_of(p, "program")?,
                modules: strings_of(p, "modules")?,
                lock: nullable(p, "lock"),
                results: members("results"),
                texts: members("texts")
                    .into_iter()
                    .filter_map(|(k, v)| v.as_str().map(|t| (k, t.to_owned())))
                    .collect(),
            })
        })
        .collect()
}

/// The codes a stored result holds, each once, sorted: those of its
/// `diagnostics`, or of the array it is.
#[must_use]
pub fn result_codes(result: &Value) -> Vec<String> {
    let diags = match result {
        Value::Array(items) => items.as_slice(),
        _ => result
            .get("diagnostics")
            .and_then(Value::as_array)
            .unwrap_or_default(),
    };
    crate::codes::code_set(
        diags
            .iter()
            .filter_map(|d| d.get("code").and_then(Value::as_str)),
    )
}

/// The repository path of `file`, a path relative to the repository
/// directory `dir` (a case's files may go up: `../../fixtures/a.mdt`), with
/// `.` and `..` resolved as text.
#[must_use]
pub fn repo_path(dir: &str, file: &str) -> String {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for p in file.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(p),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::repo_path;

    #[test]
    fn paths() {
        assert_eq!(
            repo_path("conformance/V03", "../../fixtures/a.mdt"),
            "fixtures/a.mdt"
        );
        assert_eq!(
            repo_path("conformance/N02", "../N01/./parent.mdt"),
            "conformance/N01/parent.mdt"
        );
        assert_eq!(
            repo_path("conformance/S01", "program.ir.json"),
            "conformance/S01/program.ir.json"
        );
    }
}
