//! An [`Io`] that is all in memory, for tests: files by path, what was
//! written to the two streams, and a clock that is set.

use std::collections::{BTreeMap, BTreeSet};

use crate::{DirEntry, Io, IoError, IoErrorKind};

/// An [`Io`] in memory. Paths are text with `/` between names, compared as
/// they are written: `a/b` and `./a/b` are two paths.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemoryIo {
    /// The files, by path.
    pub files: BTreeMap<String, Vec<u8>>,
    /// The directories made with [`Io::create_dir_all`].
    pub dirs: BTreeSet<String>,
    /// The paths that are there and cannot be read or written.
    pub denied: BTreeSet<String>,
    /// Standard input.
    pub input: Vec<u8>,
    /// How much of standard input [`Io::read_input_part`] has read.
    pub input_read: usize,
    /// The most bytes one [`Io::read_input_part`] gives, so that a test can
    /// cut the input where it likes; 0 is no limit but the buffer's.
    pub input_part: usize,
    /// Whether standard output is closed, so that [`Io::write_out_part`]
    /// fails.
    pub out_closed: bool,
    /// What was written to standard output.
    pub out: String,
    /// What was written to standard error.
    pub err: String,
    /// The time, in seconds since 1970-01-01T00:00:00Z.
    pub now: i64,
}

impl MemoryIo {
    /// One with no file, at the time 0.
    #[must_use]
    pub fn new() -> MemoryIo {
        MemoryIo::default()
    }

    /// Puts the file `path` with `text`.
    pub fn put(&mut self, path: &str, text: &str) {
        self.files.insert(path.to_owned(), text.as_bytes().to_vec());
    }

    /// The text of the file `path`, when it is there and is UTF-8.
    #[must_use]
    pub fn text(&self, path: &str) -> Option<&str> {
        self.files
            .get(path)
            .and_then(|b| std::str::from_utf8(b).ok())
    }

    fn refused(&self, path: &str) -> Option<IoError> {
        self.denied
            .contains(path)
            .then(|| IoError::new(IoErrorKind::Other, "permission denied"))
    }
}

impl Io for MemoryIo {
    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, IoError> {
        if let Some(e) = self.refused(path) {
            return Err(e);
        }
        self.files
            .get(path)
            .cloned()
            .ok_or_else(|| IoError::not_found("no such file"))
    }

    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), IoError> {
        if let Some(e) = self.refused(path) {
            return Err(e);
        }
        self.files.insert(path.to_owned(), bytes.to_vec());
        Ok(())
    }

    fn create_dir_all(&mut self, path: &str) -> Result<(), IoError> {
        if let Some(e) = self.refused(path) {
            return Err(e);
        }
        self.dirs.insert(path.to_owned());
        Ok(())
    }

    fn list_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, IoError> {
        if let Some(e) = self.refused(path) {
            return Err(e);
        }
        let prefix = format!("{path}/");
        let mut entries: BTreeMap<String, bool> = BTreeMap::new();
        let files = self.files.keys().map(|k| (k, false));
        let dirs = self.dirs.iter().map(|k| (k, true));
        for (key, made) in files.chain(dirs) {
            let Some(rest) = key.strip_prefix(&prefix) else {
                continue;
            };
            match rest.split_once('/') {
                Some((name, _)) => {
                    entries.insert(name.to_owned(), true);
                }
                None if !rest.is_empty() => {
                    let dir = entries.get(rest).copied().unwrap_or(false);
                    entries.insert(rest.to_owned(), dir || made);
                }
                None => {}
            }
        }
        if entries.is_empty() && !self.dirs.contains(path) {
            return Err(IoError::not_found("no such directory"));
        }
        Ok(entries
            .into_iter()
            .map(|(name, is_dir)| DirEntry { name, is_dir })
            .collect())
    }

    fn read_input(&mut self) -> Result<Vec<u8>, IoError> {
        Ok(self.input.clone())
    }

    fn read_input_part(&mut self, buf: &mut [u8]) -> Result<usize, IoError> {
        let rest = self.input.get(self.input_read..).unwrap_or_default();
        let most = if self.input_part == 0 {
            buf.len()
        } else {
            buf.len().min(self.input_part)
        };
        let n = rest.len().min(most);
        let (Some(to), Some(from)) = (buf.get_mut(..n), rest.get(..n)) else {
            return Ok(0);
        };
        to.copy_from_slice(from);
        self.input_read = self.input_read.saturating_add(n);
        Ok(n)
    }

    fn write_out(&mut self, text: &str) {
        self.out.push_str(text);
    }

    fn write_out_part(&mut self, text: &str) -> Result<(), IoError> {
        if self.out_closed {
            return Err(IoError::new(IoErrorKind::Other, "broken pipe"));
        }
        self.out.push_str(text);
        Ok(())
    }

    fn write_err(&mut self, text: &str) {
        self.err.push_str(text);
    }

    fn now_unix_seconds(&mut self) -> i64 {
        self.now
    }

    fn parent(&self, path: &str) -> String {
        match path.rsplit_once('/') {
            Some(("", _)) => "/".to_owned(),
            Some((dir, _)) => dir.to_owned(),
            None => String::new(),
        }
    }

    fn join(&self, dir: &str, name: &str) -> String {
        if name.starts_with('/') {
            name.to_owned()
        } else if dir.ends_with('/') {
            format!("{dir}{name}")
        } else {
            format!("{dir}/{name}")
        }
    }
}
