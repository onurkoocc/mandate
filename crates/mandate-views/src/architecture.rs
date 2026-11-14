//! The architecture view: each workflow as a graph of delegations with their
//! grants, parallel branches, verification, external effects and people
//! (`compiler/src/views/views.ts`, lines 277-290 and 418-457, and
//! `architectureBlocks`, lines 1513-1526). The graph is
//! [`mandate_check::Graph`], which the semantic diff also stands on.

use mandate_check::{ArchEdge, ArchKind, ArchNode, Graph, ProgramRef, VIEW_FORMAT, program_ref};
use mandate_ir::{Definition, JsObject, JsValue, Program, Value, workflow_bounds};

use crate::doc::{Block, Cell};
use crate::shown::{is_kind, list, mermaid_text, show, sorted_defs};

/// One workflow in the architecture view: `WorkflowArchitecture`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowArchitecture {
    /// The workflow's name.
    pub workflow: String,
    /// Its budget as one line.
    pub budget: String,
    /// Its steps.
    pub nodes: Vec<ArchNode>,
    /// What follows what.
    pub edges: Vec<ArchEdge>,
    /// The flowchart, as Mermaid text.
    pub mermaid: String,
}

impl WorkflowArchitecture {
    /// `{ workflow, budget, nodes, edges, mermaid }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("workflow", self.workflow.as_str())
            .with("budget", self.budget.as_str())
            .with(
                "nodes",
                JsValue::Array(self.nodes.iter().map(ArchNode::to_js).collect()),
            )
            .with(
                "edges",
                JsValue::Array(self.edges.iter().map(ArchEdge::to_js).collect()),
            )
            .with("mermaid", self.mermaid.as_str())
            .into()
    }
}

/// The architecture of a program: `ArchitectureView`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchitectureView {
    /// The program it shows.
    pub program: ProgramRef,
    /// Its workflows, by name in the order of UTF-16 code units.
    pub workflows: Vec<WorkflowArchitecture>,
}

impl ArchitectureView {
    /// `{ format, kind, program, workflows }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "architecture")
            .with("program", self.program.to_js())
            .with(
                "workflows",
                JsValue::Array(
                    self.workflows
                        .iter()
                        .map(WorkflowArchitecture::to_js)
                        .collect(),
                ),
            )
            .into()
    }
}

/// The flowchart of a workflow: `mermaid(wf, budget, nodes, edges)`.
#[must_use]
pub fn mermaid(wf: &str, budget: &str, nodes: &[ArchNode], edges: &[ArchEdge]) -> String {
    let shape = |n: &ArchNode| -> String {
        let label: Vec<String> = std::iter::once(n.label.as_str())
            .chain(n.detail.iter().map(String::as_str))
            .map(mermaid_text)
            .collect();
        let text = format!("\"{}\"", label.join("<br/>"));
        match n.kind {
            ArchKind::Verify => format!("{}{{{{{text}}}}}", n.id),
            ArchKind::Effect | ArchKind::Changeset => format!("{}[({text})]", n.id),
            ArchKind::Human => format!("{}[/{text}/]", n.id),
            ArchKind::Infer => format!("{}([{text}])", n.id),
            _ => format!("{}[{text}]", n.id),
        }
    };
    let mut lines = vec![
        "flowchart LR".to_owned(),
        format!(
            "  subgraph {}[\"workflow {} · budget {}\"]",
            mermaid_text(wf),
            mermaid_text(wf),
            mermaid_text(budget)
        ),
    ];
    for n in nodes {
        lines.push(format!("    {}", shape(n)));
    }
    lines.push("  end".to_owned());
    for e in edges {
        let label = match e.label.as_deref().filter(|l| !l.is_empty()) {
            Some(l) => format!("|{}|", mermaid_text(l)),
            None => String::new(),
        };
        lines.push(format!("  {} -->{label} {}", e.from, e.to));
    }
    lines.join("\n")
}

/// The architecture of a program: `architecture(program)`. A value that is
/// no program has no workflows.
#[must_use]
pub fn architecture(program: &Value) -> ArchitectureView {
    let mut workflows: Vec<WorkflowArchitecture> = Vec::new();
    if let Some(p) = Program::of(program) {
        for (name, d) in sorted_defs(p) {
            if !is_kind(d, "workflow") {
                continue;
            }
            let mut g = Graph::new(p, d);
            g.block(Definition::of(d).body(), Vec::new());
            let budget = show(workflow_bounds(d).budget);
            let mermaid = mermaid(name, &budget, &g.nodes, &g.edges);
            workflows.push(WorkflowArchitecture {
                workflow: name.to_owned(),
                budget,
                nodes: g.nodes,
                edges: g.edges,
                mermaid,
            });
        }
    }
    ArchitectureView {
        program: program_ref(program),
        workflows,
    }
}

/// The blocks of the architecture in a document: `architectureBlocks(v)`.
#[must_use]
pub fn architecture_blocks(v: &ArchitectureView) -> Vec<Block> {
    let mut out = vec![Block::H("Architecture".to_owned())];
    for w in &v.workflows {
        out.push(Block::P(format!(
            "Workflow {}, budget {}.",
            w.workflow, w.budget
        )));
        out.push(Block::Code {
            code: w.mermaid.clone(),
            lang: Some("mermaid".to_owned()),
            untrusted: false,
        });
        let rows = w
            .nodes
            .iter()
            .map(|n| {
                let detail = n.detail.join(" · ");
                let after: Vec<String> = w
                    .edges
                    .iter()
                    .filter(|e| e.to == n.id)
                    .map(|e| {
                        let from = w
                            .nodes
                            .iter()
                            .find(|x| x.id == e.from)
                            .map_or(e.from.as_str(), |x| x.label.as_str());
                        match e.label.as_deref().filter(|l| !l.is_empty()) {
                            Some(l) => format!("{from} ({l})"),
                            None => from.to_owned(),
                        }
                    })
                    .collect();
                vec![
                    Cell::plain(n.label.as_str()),
                    Cell::plain(n.kind.as_str()),
                    Cell::plain(if detail.is_empty() {
                        "—".to_owned()
                    } else {
                        detail
                    }),
                    Cell::plain(list(&after)),
                ]
            })
            .collect();
        out.push(Block::Table {
            head: ["Step", "Kind", "Detail", "After"]
                .map(str::to_owned)
                .to_vec(),
            rows,
        });
    }
    out
}
