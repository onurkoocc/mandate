//! The recorded conversations of `vectors/mcp/`, which
//! `scripts/mcp-vectors.mjs` writes from the Node MCP server (the bytes it
//! wrote for each), and how what the native server writes is compared with
//! them: line by line, byte for byte, but for the lines that answer
//! `tools/list`, where the Node server serves the frozen tool list and the
//! native one the list of 0.7 (until slice B9 moves the Node server to the
//! door `mcp_tools`): there the native line must be the Node line with the
//! list of 0.7 in the place of the frozen list, both as the door writes them.

#![allow(dead_code)]

use mandate_ir::{Map, Value, stringify};
use mandate_testkit::{files, first_difference, read_json, sha256};

/// The directory of the conversations.
const DIR: &str = "vectors/mcp";

/// What the Node server wrote on one line.
enum Expected {
    /// The line.
    Line(String),
    /// A long line: its digest and its length.
    Digest(String, usize),
}

/// One conversation.
pub struct Conversation {
    /// Its name, the file's.
    pub name: String,
    /// The arguments after `mandate`.
    pub args: Vec<String>,
    /// Standard input.
    pub input: Vec<u8>,
    output: Vec<Expected>,
    tools_list: Vec<usize>,
}

fn hex(text: &str) -> Vec<u8> {
    let digit = |b: u8| match b {
        b'0'..=b'9' => b - b'0',
        b'a'..=b'f' => b - b'a' + 10,
        _ => panic!("not a hex digit"),
    };
    text.as_bytes()
        .chunks(2)
        .map(|p| digit(p[0]) * 16 + digit(p[1]))
        .collect()
}

fn input_of(parts: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts {
        let s = |k: &str| p.get(k).and_then(Value::as_str);
        if let Some(line) = s("line") {
            out.extend_from_slice(line.as_bytes());
            out.push(b'\n');
        } else if let Some(text) = s("text") {
            out.extend_from_slice(text.as_bytes());
        } else if let Some(h) = s("hex") {
            out.extend(hex(h));
        } else {
            let unit = s("repeat").expect("a part is line, text, hex or repeat");
            let count = p.get("count").and_then(Value::as_i64).expect("a count");
            out.extend_from_slice(unit.repeat(usize::try_from(count).unwrap()).as_bytes());
        }
    }
    out
}

/// Every conversation, by name.
pub fn conversations() -> Vec<Conversation> {
    let mut out = Vec::new();
    for file in files(DIR).expect("vectors/mcp") {
        let v = read_json(&format!("{DIR}/{file}")).expect("a conversation");
        assert_eq!(
            v.get("format").and_then(Value::as_str),
            Some("mandate/vectors/mcp/0.1"),
            "{file}"
        );
        let strings = |k: &str| -> Vec<String> {
            v.get(k)
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("{file}: {k}"))
                .iter()
                .map(|a| a.as_str().expect("a string").to_owned())
                .collect()
        };
        let output = v
            .get("output")
            .and_then(Value::as_array)
            .expect("output")
            .iter()
            .map(|l| match l {
                Value::String(s) => Expected::Line(s.clone()),
                other => Expected::Digest(
                    other
                        .get("sha256")
                        .and_then(Value::as_str)
                        .expect("a digest")
                        .to_owned(),
                    usize::try_from(other.get("bytes").and_then(Value::as_i64).expect("bytes"))
                        .unwrap(),
                ),
            })
            .collect();
        let tools_list = v
            .get("tools_list")
            .and_then(Value::as_array)
            .expect("tools_list")
            .iter()
            .map(|i| usize::try_from(i.as_i64().expect("an index")).unwrap())
            .collect();
        out.push(Conversation {
            name: v
                .get("name")
                .and_then(Value::as_str)
                .expect("name")
                .to_owned(),
            args: strings("args"),
            input: input_of(v.get("input").and_then(Value::as_array).expect("input")),
            output,
            tools_list,
        });
    }
    out
}

/// The `tools` member of the door `mcp_tools`'s answer for `language`, as
/// JSON text.
pub fn tools_text(language: &str) -> String {
    let mut input = Map::new();
    input.insert("language", language);
    let door = mandate_doors::door("mcp_tools").expect("the door mcp_tools");
    let out = (door.call)(&Value::Object(input)).expect("the door answers");
    stringify(out.get("tools").expect("tools")).expect("text")
}

impl Conversation {
    /// The files the conversation's `--module` arguments name.
    pub fn module_files(&self) -> Vec<&str> {
        self.args
            .windows(2)
            .filter(|w| w[0] == "--module")
            .map(|w| w[1].as_str())
            .collect()
    }

    /// How many answers the Node server wrote.
    pub fn answers(&self) -> usize {
        self.output.len()
    }

    /// Whether `written`, what the native server wrote, is what the Node
    /// server wrote; where it is not.
    ///
    /// # Errors
    ///
    /// The first line that differs, and how.
    pub fn compare(&self, written: &str, frozen: &str, of_0_7: &str) -> Result<(), String> {
        let lines: Vec<&str> = match written.strip_suffix('\n') {
            Some(body) => body.split('\n').collect(),
            None if written.is_empty() => Vec::new(),
            None => {
                return Err(format!(
                    "{}: the output does not end with a line feed",
                    self.name
                ));
            }
        };
        for (i, want) in self.output.iter().enumerate() {
            let Some(got) = lines.get(i) else {
                return Err(format!(
                    "{}: {} lines, not {}",
                    self.name,
                    lines.len(),
                    self.output.len()
                ));
            };
            match want {
                Expected::Line(want) => {
                    let want = if self.tools_list.contains(&i) {
                        assert!(
                            want.contains(frozen),
                            "{}: line {i} holds the frozen list",
                            self.name
                        );
                        // B9: until the Node server serves the list of 0.7 too.
                        want.replacen(frozen, of_0_7, 1)
                    } else {
                        want.clone()
                    };
                    if let Some(d) = first_difference(&want, got) {
                        return Err(format!("{}: answer {i}: {d}", self.name));
                    }
                }
                Expected::Digest(digest, bytes) => {
                    if sha256(got) != *digest || got.len() != *bytes {
                        return Err(format!(
                            "{}: answer {i}: {} bytes, {}; not the {bytes} bytes {digest}; it begins {:?}",
                            self.name,
                            got.len(),
                            sha256(got),
                            got.chars().take(300).collect::<String>()
                        ));
                    }
                }
            }
        }
        if lines.len() != self.output.len() {
            return Err(format!(
                "{}: {} lines, not {}",
                self.name,
                lines.len(),
                self.output.len()
            ));
        }
        Ok(())
    }
}
