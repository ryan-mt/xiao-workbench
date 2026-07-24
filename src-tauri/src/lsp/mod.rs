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
    json!([{
        "type": "namespace",
        "name": "xiao_lsp",
        "description": "Read-only semantic code intelligence scoped to the active Xiao execution root.",
        "tools": [
            {
                "type": "function",
                "name": "definition",
                "description": "Find the definition at a one-based UTF-16 position in a TypeScript, JavaScript, or Rust file.",
                "inputSchema": position_schema(false),
            },
            {
                "type": "function",
                "name": "references",
                "description": "Find references at a one-based UTF-16 position in a TypeScript, JavaScript, or Rust file.",
                "inputSchema": position_schema(true),
            },
            {
                "type": "function",
                "name": "workspace_symbols",
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
                "name": "diagnostics",
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
            }
        ]
    }, {
        "type": "namespace",
        "name": "xiao_runtime",
        "description": "Read-only diagnostics for the active Xiao run and its effective access policy.",
        "tools": [{
            "type": "function",
            "name": "diagnostics",
            "description": "Read the active run snapshot, effective sandbox policy, and recent sanitized run events.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                },
                "additionalProperties": false
            }
        }]
    }, {
        "type": "namespace",
        "name": "xiao_preview",
        "description": "Task-scoped inspection and bounded automation for Preview targets registered by the Xiao host.",
        "tools": [{
            "type": "function",
            "name": "targets",
            "description": "List Preview targets registered for the active Task and its frozen execution root.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        }, {
            "type": "function",
            "name": "automate",
            "description": "Click, focus, or fill one selector in a registered Preview target for the active Task.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string", "maxLength": 96 },
                    "action": { "type": "string", "enum": ["click", "focus", "fill"] },
                    "selector": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "value": { "type": "string", "maxLength": 2000 }
                },
                "required": ["label", "action", "selector"],
                "allOf": [{
                    "if": {
                        "properties": {
                            "action": { "const": "fill" }
                        },
                        "required": ["action"]
                    },
                    "then": {
                        "required": ["value"]
                    }
                }],
                "additionalProperties": false
            }
        }]
    }])
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
    fn tool_specs_are_read_only_and_namespaced() {
        let specs = dynamic_tool_specs();
        let namespace = &specs[0];
        assert_eq!(namespace["name"], "xiao_lsp");
        let names = namespace["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "definition",
                "references",
                "workspace_symbols",
                "diagnostics"
            ]
        );
        assert!(!specs.to_string().contains("rename"));
        assert!(!specs.to_string().contains("code_action"));
        assert_eq!(specs[1]["name"], "xiao_runtime");
        assert_eq!(specs[1]["tools"][0]["name"], "diagnostics");
        assert_eq!(specs[2]["name"], "xiao_preview");
        assert_eq!(specs[2]["tools"][0]["name"], "targets");
        assert_eq!(specs[2]["tools"][1]["name"], "automate");
        assert_eq!(
            specs[2]["tools"][1]["inputSchema"]["allOf"][0]["if"]["properties"]["action"]["const"],
            "fill"
        );
        assert_eq!(
            specs[2]["tools"][1]["inputSchema"]["allOf"][0]["then"]["required"],
            json!(["value"])
        );
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
