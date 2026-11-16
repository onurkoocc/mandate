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

    fn write_out(&mut self, text: &str) {
        self.out.push_str(text);
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
