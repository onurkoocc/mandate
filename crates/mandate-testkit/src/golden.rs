//! The golden file of the TypeScript compiler, `compiler/test/golden/outputs.json`
//! (written by `compiler/test/golden.test.ts`): for each program, the
//! `sha256:` digest of what each command prints for it, by the command's
//! name (`check`, `load`, `ir --canonical`, `fmt`, `hash`, the views,
//! `sandbox`; see that test for exactly what each one is).

use mandate_ir::Value;

/// The golden file, relative to the repository root.
pub const GOLDEN: &str = "compiler/test/golden/outputs.json";

/// One pinned output: a program, an output name and its digest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GoldenOutput<'a> {
    /// The program's path from the repository root, such as
    /// `fixtures/fixbug/fixbug.ir.json`.
    pub program: &'a str,
    /// The output's name, such as `ir --canonical`.
    pub output: &'a str,
    /// The digest pinned for it, `sha256:<hex>`.
    pub digest: &'a str,
}

impl GoldenOutput<'_> {
    /// The output's name in a gate: `<output> @ <program>`, such as
    /// `ir --canonical @ fixtures/fixbug/fixbug.ir.json`.
    #[must_use]
    pub fn name(&self) -> String {
        format!("{} @ {}", self.output, self.program)
    }
}

/// The golden digests, in the file's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Golden {
    programs: Vec<(String, Vec<(String, String)>)>,
}

impl Golden {
    /// Reads the golden file.
    ///
    /// # Errors
    ///
    /// When it cannot be read or does not have the golden file's shape.
    pub fn load() -> Result<Golden, String> {
        Golden::from_value(&crate::read_json(GOLDEN)?).map_err(|e| format!("{GOLDEN}: {e}"))
    }

    /// The golden digests in `value`, the golden file read as JSON.
    ///
    /// # Errors
    ///
    /// When `value` is not an object of objects of strings.
    pub fn from_value(value: &Value) -> Result<Golden, String> {
        let file = value.as_object().ok_or("not an object")?;
        let mut programs = Vec::new();
        for (program, row) in file.iter() {
            let row = row
                .as_object()
                .ok_or_else(|| format!("{program}: not an object"))?;
            let mut outputs = Vec::new();
            for (output, digest) in row.iter() {
                let digest = digest
                    .as_str()
                    .ok_or_else(|| format!("{program}: {output}: not a string"))?;
                outputs.push((output.to_owned(), digest.to_owned()));
            }
            programs.push((program.to_owned(), outputs));
        }
        Ok(Golden { programs })
    }

    /// The programs, in order.
    pub fn programs(&self) -> impl Iterator<Item = &str> {
        self.programs.iter().map(|(p, _)| p.as_str())
    }

    /// Every output name that occurs, each once, in the order first seen.
    #[must_use]
    pub fn output_names(&self) -> Vec<&str> {
        mandate_ir::unique_in_order(self.outputs().map(|o| o.output))
    }

    /// Every pinned output, program by program, in the file's order.
    pub fn outputs(&self) -> impl Iterator<Item = GoldenOutput<'_>> {
        self.programs.iter().flat_map(|(program, outputs)| {
            outputs.iter().map(move |(output, digest)| GoldenOutput {
                program,
                output,
                digest,
            })
        })
    }

    /// The digest pinned for `output` of `program`, if there is one (a
    /// program that does not check has no views, and one without a lock
    /// file has no `check --lock`).
    #[must_use]
    pub fn digest(&self, program: &str, output: &str) -> Option<&str> {
        self.outputs()
            .find(|o| o.program == program && o.output == output)
            .map(|o| o.digest)
    }
}
