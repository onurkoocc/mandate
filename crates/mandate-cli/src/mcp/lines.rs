//! The lines of the server's input, as `readLines` of `bridge/src/mcp.ts`
//! gives them: split at `\n`, `\r\n` or a lone `\r` (where Node's
//! `readline` splits), a `\r\n` that falls across two reads being one
//! break, and a last line without a break given at the end. A line longer
//! than the limit (its break not counted) is read through to its end
//! without being kept: only its length is.

/// One line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Line {
    /// Its bytes, without the break.
    Bytes(Vec<u8>),
    /// A line longer than the limit, and how many bytes it had.
    TooLarge(usize),
}

/// The line being read.
#[derive(Debug)]
pub(crate) struct Lines {
    /// The most bytes a line may have.
    most: usize,
    /// The line so far, while it is within the limit; nothing once it is
    /// past it.
    kept: Vec<u8>,
    /// How many bytes the line has so far.
    size: usize,
    /// Whether the last byte read was a `\r`, so that a `\n` right after it
    /// is no line of its own.
    after_cr: bool,
}

impl Lines {
    /// Lines of at most `most` bytes.
    pub(crate) fn new(most: usize) -> Lines {
        Lines {
            most,
            kept: Vec::new(),
            size: 0,
            after_cr: false,
        }
    }

    /// Takes `bytes` into the line.
    fn take(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.size = self.size.saturating_add(bytes.len());
        if self.size > self.most {
            // Dropped, and its memory given back.
            self.kept = Vec::new();
        } else {
            self.kept.extend_from_slice(bytes);
        }
    }

    /// The line read, and a new one begun.
    fn finish(&mut self) -> Line {
        let line = if self.size > self.most {
            Line::TooLarge(self.size)
        } else {
            Line::Bytes(std::mem::take(&mut self.kept))
        };
        self.kept = Vec::new();
        self.size = 0;
        line
    }

    /// Reads `chunk`; the lines that end in it.
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Vec<Line> {
        let mut out = Vec::new();
        let mut from = 0;
        for (i, b) in chunk.iter().enumerate() {
            if self.after_cr {
                self.after_cr = false;
                if *b == b'\n' {
                    from = i.saturating_add(1);
                    continue;
                }
            }
            if *b == b'\n' || *b == b'\r' {
                self.take(chunk.get(from..i).unwrap_or_default());
                out.push(self.finish());
                from = i.saturating_add(1);
                self.after_cr = *b == b'\r';
            }
        }
        self.take(chunk.get(from..).unwrap_or_default());
        out
    }

    /// The last line, at the end of the input, when it has any byte.
    pub(crate) fn end(&mut self) -> Option<Line> {
        (self.size > 0).then(|| self.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::{Line, Lines};

    fn split(chunks: &[&[u8]], most: usize) -> Vec<Line> {
        let mut lines = Lines::new(most);
        let mut out = Vec::new();
        for c in chunks {
            out.extend(lines.feed(c));
        }
        out.extend(lines.end());
        out
    }

    fn bytes(s: &str) -> Line {
        Line::Bytes(s.as_bytes().to_vec())
    }

    #[test]
    fn lines_split_where_readline_splits_them() {
        assert_eq!(
            split(&[b"a\nb\r\nc\rd", b"\r", b"\ne\n\n", b"f"], 100),
            [
                bytes("a"),
                bytes("b"),
                bytes("c"),
                bytes("d"),
                bytes("e"),
                bytes(""),
                bytes("f")
            ]
        );
        // A lone CR at the end, then nothing: no line after it.
        assert_eq!(split(&[b"a\r"], 100), [bytes("a")]);
        assert_eq!(split(&[b"\r\r\n"], 100), [bytes(""), bytes("")]);
        assert_eq!(split(&[], 100), []);
    }

    #[test]
    fn a_line_over_the_limit_keeps_only_its_length() {
        let mut lines = Lines::new(4);
        assert_eq!(lines.feed(b"abcd\nabc"), [bytes("abcd")]);
        assert!(lines.feed(b"de").is_empty());
        assert!(lines.kept.is_empty());
        assert_eq!(lines.feed(b"fg\r\nok\n"), [Line::TooLarge(7), bytes("ok")]);
        assert_eq!(split(&[b"abcde"], 4), [Line::TooLarge(5)]);
    }
}
