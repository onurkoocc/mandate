//! The arguments of a command, read as `main` of `bridge/src/cli.ts` reads
//! them: the options that take a value are taken out wherever they stand,
//! each with the argument after it; of what is left, an argument that
//! starts with `--` is a flag and any other is positional.

/// The arguments could not be read: an option that takes a value is the
/// last argument.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MissingValue;

/// The arguments of a command.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Args {
    /// `--module <file>`, each one, in order.
    pub modules: Vec<String>,
    /// `--agent <name>`.
    pub agent: Option<String>,
    /// `--lock <file>`.
    pub lock: Option<String>,
    /// `--out <dir>`.
    pub out: Option<String>,
    /// `--against <file>`.
    pub against: Option<String>,
    /// `--against-lock <file>`.
    pub against_lock: Option<String>,
    /// `--denials <file>`.
    pub denials: Option<String>,
    /// `--workflow <name>`.
    pub workflow: Option<String>,
    /// `--format <format>`; `md` when it is not given.
    pub format: String,
    /// `--libraries <dir>`.
    pub libraries: Option<String>,
    /// `--config <file>`.
    pub config: Option<String>,
    /// The flags, each as written (`--json`).
    pub flags: Vec<String>,
    /// The positional arguments.
    pub positional: Vec<String>,
}

/// Takes the first `name` and the argument after it out of `rest`, and
/// gives that argument.
fn option(rest: &mut Vec<String>, name: &str) -> Result<Option<String>, MissingValue> {
    let Some(at) = rest.iter().position(|a| a == name) else {
        return Ok(None);
    };
    let value_at = at.saturating_add(1);
    if value_at >= rest.len() {
        return Err(MissingValue);
    }
    let value = rest.remove(value_at);
    rest.remove(at);
    Ok(Some(value))
}

impl Args {
    /// Reads the arguments after the command's name.
    ///
    /// # Errors
    ///
    /// [`MissingValue`] when an option that takes a value has none.
    pub(crate) fn read(after_command: &[String]) -> Result<Args, MissingValue> {
        let mut rest: Vec<String> = after_command.to_vec();
        let mut modules = Vec::new();
        while let Some(m) = option(&mut rest, "--module")? {
            modules.push(m);
        }
        // In the order of cli.ts, then the two options of 0.6.
        let agent = option(&mut rest, "--agent")?;
        let lock = option(&mut rest, "--lock")?;
        let out = option(&mut rest, "--out")?;
        let against = option(&mut rest, "--against")?;
        let against_lock = option(&mut rest, "--against-lock")?;
        let denials = option(&mut rest, "--denials")?;
        let workflow = option(&mut rest, "--workflow")?;
        let format = option(&mut rest, "--format")?.unwrap_or_else(|| "md".to_owned());
        let libraries = option(&mut rest, "--libraries")?;
        let config = option(&mut rest, "--config")?;
        let (flags, positional) = rest.into_iter().partition(|a| a.starts_with("--"));
        Ok(Args {
            modules,
            agent,
            lock,
            out,
            against,
            against_lock,
            denials,
            workflow,
            format,
            libraries,
            config,
            flags,
            positional,
        })
    }

    /// Whether the flag `name` was given.
    pub(crate) fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|f| f == name)
    }

    /// `--json`.
    pub(crate) fn json(&self) -> bool {
        self.flag("--json")
    }

    /// The positional argument at `index`.
    pub(crate) fn arg(&self, index: usize) -> Option<&str> {
        self.positional.get(index).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::{Args, MissingValue};

    fn read(args: &[&str]) -> Result<Args, MissingValue> {
        let owned: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        Args::read(&owned)
    }

    #[test]
    fn options_are_taken_out_wherever_they_stand() {
        let a = read(&[
            "--module", "a.mdt", "p.mdt", "--json", "--lock", "l.json", "--module", "b.mdt",
            "--card",
        ])
        .unwrap_or_default();
        assert_eq!(a.modules, ["a.mdt", "b.mdt"]);
        assert_eq!(a.lock.as_deref(), Some("l.json"));
        assert_eq!(a.positional, ["p.mdt"]);
        assert_eq!(a.flags, ["--json", "--card"]);
        assert!(a.json() && a.flag("--card") && !a.flag("--canonical"));
        assert_eq!(a.format, "md");
        assert_eq!(a.arg(0), Some("p.mdt"));
        assert_eq!(a.arg(1), None);
    }

    #[test]
    fn an_option_takes_the_argument_after_it_whatever_it_is() {
        // As cli.ts: `--format --json` is the format `--json`.
        let a = read(&["f", "--format", "--json"]).unwrap_or_default();
        assert_eq!(a.format, "--json");
        assert!(!a.json());
    }

    #[test]
    fn an_option_without_a_value_is_refused() {
        assert_eq!(read(&["f", "--lock"]), Err(MissingValue));
        assert_eq!(read(&["--libraries"]), Err(MissingValue));
        assert_eq!(read(&["f", "--module", "m", "--module"]), Err(MissingValue));
    }
}
