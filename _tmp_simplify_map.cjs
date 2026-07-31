const fs = require("fs");
const path = "src-tauri/src/xai/service.rs";
let src = fs.readFileSync(path, "utf8");

// Simplify response event mapping: only map complete items, not fragile argument deltas.
const oldMap = `fn map_xai_response_event_to_codex(mut event: Value) -> Value {
    let Some(event_type) = event.get("type").and_then(Value::as_str).map(str::to_owned) else {
        return event;
    };

    match event_type.as_str() {
        "response.output_item.added" | "response.output_item.done" => {
            if let Some(item) = event.get_mut("item") {
                map_xai_output_item_to_codex(item);
            }
        }
        "response.function_call_arguments.delta" => {
            if event_targets_apply_patch_function(&event) {
                if let Some(object) = event.as_object_mut() {
                    object.insert(
                        "type".to_owned(),
                        Value::String("response.custom_tool_call_input.delta".to_owned()),
                    );
                    if let Some(delta) = object.get("delta").cloned() {
                        // function_call_arguments.delta streams JSON fragments for {"input":"..."}.
                        // Best-effort unwrap: if the whole delta is a JSON object with input, pass through input text.
                        if let Some(text) = delta.as_str() {
                            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text) {
                                if let Some(Value::String(input)) = map.get("input") {
                                    object.insert(
                                        "delta".to_owned(),
                                        Value::String(input.clone()),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
        "response.completed" | "response.incomplete" | "response.failed" => {
            if let Some(output) = event
                .pointer_mut("/response/output")
                .and_then(Value::as_array_mut)
            {
                for item in output.iter_mut() {
                    map_xai_output_item_to_codex(item);
                }
            }
        }
        _ => {}
    }
    event
}

fn event_targets_apply_patch_function(event: &Value) -> bool {
    if event
        .pointer("/item/name")
        .and_then(Value::as_str)
        == Some("apply_patch")
    {
        return true;
    }
    event.get("name").and_then(Value::as_str) == Some("apply_patch")
}`;

const newMap = `fn map_xai_response_event_to_codex(mut event: Value) -> Value {
    let Some(event_type) = event.get("type").and_then(Value::as_str).map(str::to_owned) else {
        return event;
    };

    match event_type.as_str() {
        // Map complete apply_patch function calls back to Codex custom/freeform tool calls.
        // Argument deltas stay as function_call_arguments.* — only the finished item is required
        // for execution (same practical path grokapp uses with structured function tools).
        "response.output_item.added" | "response.output_item.done" => {
            if let Some(item) = event.get_mut("item") {
                map_xai_output_item_to_codex(item);
            }
        }
        "response.completed" | "response.incomplete" | "response.failed" => {
            if let Some(output) = event
                .pointer_mut("/response/output")
                .and_then(Value::as_array_mut)
            {
                for item in output.iter_mut() {
                    map_xai_output_item_to_codex(item);
                }
            }
        }
        _ => {}
    }
    event
}`;

if (!src.includes(oldMap)) {
  console.error("map fn not found");
  process.exit(1);
}
src = src.replace(oldMap, newMap);

// Drop unused HashMap import if present and unused
if (src.startsWith("use std::collections::HashMap;\n")) {
  src = src.replace("use std::collections::HashMap;\n", "");
}

fs.writeFileSync(path, src);
console.log("simplified mapping");
