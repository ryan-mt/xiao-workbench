mod protocol;
mod service;

use semver::Version;
use serde_json::{json, Value};

pub(crate) use service::LspManager;

const MINIMUM_DYNAMIC_TOOL_VERSION: Version = Version::new(0, 144, 6);
const MAX_DYNAMIC_TOOL_OUTPUT_BYTES: usize = 256 * 1024;

pub(crate) fn codex_supports_dynamic_tools(version: &str) -> bool {
    version
        .split_whitespace()
        .find_map(|part| Version::parse(part.trim_start_matches('v')).ok())
        .is_some_and(|version| version >= MINIMUM_DYNAMIC_TOOL_VERSION)
}

pub(crate) fn dynamic_tool_specs() -> Value {
    json!([
        {
            "type": "function",
            "name": "xiao_lsp_definition",
            "description": "Find the definition at a one-based UTF-16 position in a TypeScript, JavaScript, or Rust file.",
            "inputSchema": position_schema(false),
        },
        {
            "type": "function",
            "name": "xiao_lsp_references",
            "description": "Find references at a one-based UTF-16 position in a TypeScript, JavaScript, or Rust file.",
            "inputSchema": position_schema(true),
        },
        {
            "type": "function",
            "name": "xiao_lsp_workspace_symbols",
            "description": "Search semantic symbols in the active execution root. Choose typescript or rust explicitly.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "enum": ["typescript", "rust"]
                    },
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                },
                "required": ["language", "query"],
                "additionalProperties": false
            },
        },
        {
            "type": "function",
            "name": "xiao_lsp_diagnostics",
            "description": "Read diagnostics for a TypeScript, JavaScript, or Rust file after synchronizing its current disk contents.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                },
                "required": ["path"],
                "additionalProperties": false
            },
        },
        {
            "type": "function",
            "name": "xiao_runtime_diagnostics",
            "description": "Read the active Xiao run snapshot, effective sandbox policy, and recent sanitized run events.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                },
                "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": "xiao_preview_targets",
            "description": "List Preview targets registered for the active Task and its frozen execution root.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "type": "function",
            "name": "xiao_preview_automate",
            "description": "Click, focus, or fill one selector in a registered Preview target for the active Task. For action=fill, include value.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string", "maxLength": 96 },
                    "action": { "type": "string", "enum": ["click", "focus", "fill"] },
                    "selector": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "value": { "type": "string", "maxLength": 2000 }
                },
                "required": ["label", "action", "selector"],
                "additionalProperties": false
            }
        }
    ])
}

fn position_schema(include_declaration: bool) -> Value {
    let mut properties = serde_json::Map::from_iter([
        ("path".to_owned(), json!({ "type": "string" })),
        (
            "line".to_owned(),
            json!({ "type": "integer", "minimum": 1 }),
        ),
        (
            "character".to_owned(),
            json!({ "type": "integer", "minimum": 1 }),
        ),
        (
            "limit".to_owned(),
            json!({ "type": "integer", "minimum": 1, "maximum": 200 }),
        ),
    ]);
    if include_declaration {
        properties.insert(
            "includeDeclaration".to_owned(),
            json!({ "type": "boolean" }),
        );
    }
    json!({
        "type": "object",
        "properties": properties,
        "required": ["path", "line", "character"],
        "additionalProperties": false
    })
}

pub(crate) fn dynamic_tool_response(result: Result<Value, String>) -> Value {
    let (success, value) = match result {
        Ok(value) => (true, value),
        Err(error) => (false, json!({ "error": error })),
    };
    let mut text = serde_json::to_string(&value)
        .unwrap_or_else(|_| r#"{"error":"Could not encode the LSP result."}"#.to_owned());
    if text.len() > MAX_DYNAMIC_TOOL_OUTPUT_BYTES {
        text = r#"{"error":"The LSP result is too large. Narrow the query or lower the result limit."}"#
            .to_owned();
        return json!({
            "success": false,
            "contentItems": [{ "type": "inputText", "text": text }]
        });
    }
    json!({
        "success": success,
        "contentItems": [{ "type": "inputText", "text": text }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_tools_are_version_gated() {
        assert!(codex_supports_dynamic_tools("codex-cli 0.144.6"));
        assert!(codex_supports_dynamic_tools("0.145.0"));
        assert!(!codex_supports_dynamic_tools("codex-cli 0.144.5"));
        assert!(!codex_supports_dynamic_tools("unknown"));
    }

    #[test]
    fn tool_specs_use_portable_top_level_functions() {
        let specs = dynamic_tool_specs();
        let specs = specs
            .as_array()
            .expect("dynamic tool specs should be an array");
        assert!(specs.iter().all(|tool| tool["type"] == "function"));
        let names = specs
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "xiao_lsp_definition",
                "xiao_lsp_references",
                "xiao_lsp_workspace_symbols",
                "xiao_lsp_diagnostics",
                "xiao_runtime_diagnostics",
                "xiao_preview_targets",
                "xiao_preview_automate",
            ]
        );
        let encoded = serde_json::to_string(specs).unwrap();
        assert!(!encoded.contains("rename"));
        assert!(!encoded.contains("code_action"));
        assert!(!encoded.contains("allOf"));
        assert!(!encoded.contains("\"const\""));
        assert_eq!(
            specs[6]["inputSchema"]["properties"]["action"]["enum"],
            json!(["click", "focus", "fill"])
        );
        assert_eq!(
            specs[6]["inputSchema"]["required"],
            json!(["label", "action", "selector"])
        );
        assert!(specs[6]["description"]
            .as_str()
            .unwrap()
            .contains("action=fill"));
    }

    #[test]
    fn failed_tool_calls_use_the_codex_dynamic_tool_response_shape() {
        let response = dynamic_tool_response(Err("not available".to_owned()));
        assert_eq!(response["success"], false);
        assert_eq!(response["contentItems"][0]["type"], "inputText");
        assert!(response["contentItems"][0]["text"]
            .as_str()
            .unwrap()
            .contains("not available"));
    }

    #[test]
    fn oversized_tool_results_are_rejected_before_reaching_codex() {
        let response = dynamic_tool_response(Ok(json!({
            "value": "x".repeat(MAX_DYNAMIC_TOOL_OUTPUT_BYTES)
        })));
        assert_eq!(response["success"], false);
        assert!(response["contentItems"][0]["text"]
            .as_str()
            .unwrap()
            .contains("too large"));
    }
}
