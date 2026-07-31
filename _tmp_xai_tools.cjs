const fs = require("fs");
const path = "src-tauri/src/xai/service.rs";
let src = fs.readFileSync(path, "utf8");

const oldInstructions = `You are a careful coding agent working in Xiao. Follow the system and developer instructions and complete the user's task.\\n\\n# Shared tools\\n\\nUse only tools provided in the current request. Do not invent tools that are not listed. Client-side tools use JSON function arguments.\\n\\nCore tools you should expect and prefer when available:\\n- shell_command: run shell commands, inspect the workspace, and make file edits when apply_patch is unavailable. Prefer rg for search. On Windows PowerShell, prefer single-quoted paths/regexes; backslash does not escape quotes.\\n- view_image: inspect a local image path the user attached or that already exists on disk.\\n- update_plan: publish and continuously update multi-step task plans.\\n- request_user_input: ask a short multiple-choice question only when a decision truly blocks progress.\\n- get_goal / update_goal: when a Xiao goal is active, read it first and update completion status only when truly done.\\n- xiao_lsp_definition, xiao_lsp_references, xiao_lsp_workspace_symbols, xiao_lsp_diagnostics: read-only semantic code intelligence for TypeScript/JavaScript/Rust.\\n- xiao_runtime_diagnostics: inspect the active Xiao run snapshot, sandbox policy, and recent events.\\n- xiao_preview_targets / xiao_preview_automate: inspect and perform bounded clicks/focus/fill on Task Preview targets. For action=fill, include value.\\n\\nParallel tool calls are supported when independent. Never emit custom or freeform tool calls outside the provided tool list. If apply_patch is not listed, do not attempt freeform patch calls; edit files with shell_command instead.\\n\\nWeb search, multi-agent orchestration, plugins, and apps may be unavailable in this profile. Stay inside the tools actually provided for the turn.`;

const newInstructions = `You are a careful coding agent working in Xiao. Follow the system and developer instructions and complete the user's task.\\n\\n# Shared tools\\n\\nUse only tools provided in the current request. Do not invent tools that are not listed. Client-side tools use JSON function arguments unless a tool is explicitly freeform.\\n\\nCore tools you should expect and prefer when available:\\n- apply_patch: preferred tool for creating or editing local files. This is a FREEFORM tool — send the patch text directly, do not wrap it in JSON.\\n- shell_command: run shell commands, search the workspace, and perform bulk/mechanical edits when apply_patch is a poor fit. Prefer rg for search. On Windows PowerShell, prefer single-quoted paths/regexes; backslash does not escape quotes.\\n- view_image: inspect a local image path the user attached or that already exists on disk.\\n- update_plan: publish and continuously update multi-step task plans.\\n- request_user_input: ask a short multiple-choice question only when a decision truly blocks progress.\\n- get_goal / update_goal: when a Xiao goal is active, read it first and update completion status only when truly done.\\n- xiao_lsp_definition, xiao_lsp_references, xiao_lsp_workspace_symbols, xiao_lsp_diagnostics: read-only semantic code intelligence for TypeScript/JavaScript/Rust.\\n- xiao_runtime_diagnostics: inspect the active Xiao run snapshot, sandbox policy, and recent events.\\n- xiao_preview_targets / xiao_preview_automate: inspect and perform bounded clicks/focus/fill on Task Preview targets. For action=fill, include value.\\n\\nParallel tool calls are supported when independent. Never invent tools outside the provided tool list. Prefer apply_patch over shell rewrites for ordinary source edits.\\n\\nWeb search, multi-agent orchestration, plugins, and apps may be unavailable in this profile. Stay inside the tools actually provided for the turn.`;

if (!src.includes(oldInstructions)) {
  console.error("base_instructions block not found");
  process.exit(1);
}
src = src.replace(oldInstructions, newInstructions);
src = src.replace(
  `"apply_patch_tool_type": null,`,
  `"apply_patch_tool_type": "freeform",`
);

// Update sanitize_responses_request
const oldSanitize = `fn sanitize_responses_request(mut request: Value) -> Result<Value, (StatusCode, String)> {
    let input = request
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or((
            StatusCode::BAD_REQUEST,
            "The xAI Responses request has no input array.".to_owned(),
        ))?;
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    let mut request_size = xai_request_size(&request)?;
    normalize_xai_image_inputs(&mut request, &mut request_size)?;
    project_xai_tool_schemas(&mut request);
    ensure_xai_request_size(&request)?;
    Ok(request)
}`;

const newSanitize = `fn sanitize_responses_request(mut request: Value) -> Result<Value, (StatusCode, String)> {
    let input = request
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or((
            StatusCode::BAD_REQUEST,
            "The xAI Responses request has no input array.".to_owned(),
        ))?;
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    for item in input.iter_mut() {
        project_xai_input_item(item);
    }
    let mut request_size = xai_request_size(&request)?;
    normalize_xai_image_inputs(&mut request, &mut request_size)?;
    project_xai_tool_schemas(&mut request);
    ensure_xai_request_size(&request)?;
    Ok(request)
}`;

if (!src.includes(oldSanitize)) {
  console.error("sanitize_responses_request not found");
  process.exit(1);
}
src = src.replace(oldSanitize, newSanitize);

// Replace project_xai_tool_schemas and project_xai_function_tool with expanded versions
const oldProject = `fn project_xai_tool_schemas(request: &mut Value) {
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        if tool.get("type").and_then(Value::as_str) != Some("function") {
            continue;
        }
        project_xai_function_tool(tool);
    }
}

fn project_xai_function_tool(tool: &mut Value) {
    let Some(object) = tool.as_object_mut() else {
        return;
    };

    // Codex dynamic tools and some client tools use inputSchema; xAI Responses expects parameters.
    if !object.contains_key("parameters") {
        if let Some(schema) = object.remove("inputSchema") {
            object.insert("parameters".to_owned(), schema);
        }
    } else {
        object.remove("inputSchema");
    }

    if let Some(parameters) = object.get_mut("parameters") {
        sanitize_portable_json_schema(parameters);
        coerce_known_integer_schema_types(parameters);
    }
}`;

const newProject = `fn project_xai_tool_schemas(request: &mut Value) {
    let Some(tools) = request.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        match tool.get("type").and_then(Value::as_str) {
            Some("function") => project_xai_function_tool(tool),
            // xAI accepts structured function tools; Codex freeform/custom tools (apply_patch)
            // are projected to a single-string function parameter.
            Some("custom") => project_xai_custom_tool_as_function(tool),
            _ => {}
        }
    }
}

fn project_xai_custom_tool_as_function(tool: &mut Value) {
    let Some(object) = tool.as_object_mut() else {
        return;
    };
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("custom_tool")
        .to_owned();
    let description = object
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("Freeform tool input.")
        .to_owned();
    let input_description = if name == "apply_patch" {
        "Raw apply_patch text. Do not wrap the patch in JSON."
    } else {
        "Raw freeform tool input. Do not wrap the value in JSON unless the tool description requires it."
    };
    *tool = json!({
        "type": "function",
        "name": name,
        "description": description,
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": input_description
                }
            },
            "required": ["input"],
            "additionalProperties": false
        }
    });
}

fn project_xai_function_tool(tool: &mut Value) {
    let Some(object) = tool.as_object_mut() else {
        return;
    };

    // Codex dynamic tools and some client tools use inputSchema; xAI Responses expects parameters.
    if !object.contains_key("parameters") {
        if let Some(schema) = object.remove("inputSchema") {
            object.insert("parameters".to_owned(), schema);
        }
    } else {
        object.remove("inputSchema");
    }

    if let Some(parameters) = object.get_mut("parameters") {
        sanitize_portable_json_schema(parameters);
        coerce_known_integer_schema_types(parameters);
    }
}

fn project_xai_input_item(item: &mut Value) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    match object.get("type").and_then(Value::as_str) {
        Some("custom_tool_call") => {
            let input = object
                .get("input")
                .cloned()
                .unwrap_or(Value::String(String::new()));
            let arguments = match input {
                Value::String(text) => json!({ "input": text }).to_string(),
                other => json!({ "input": other }).to_string(),
            };
            object.insert("type".to_owned(), Value::String("function_call".to_owned()));
            object.insert("arguments".to_owned(), Value::String(arguments));
            object.remove("input");
        }
        Some("custom_tool_call_output") => {
            let output = object.get("output").cloned().unwrap_or(Value::Null);
            object.insert(
                "type".to_owned(),
                Value::String("function_call_output".to_owned()),
            );
            // Preserve string outputs; wrap structured payloads as JSON text for xAI.
            match output {
                Value::String(_) => {}
                other => {
                    object.insert(
                        "output".to_owned(),
                        Value::String(other.to_string()),
                    );
                }
            }
        }
        _ => {}
    }
}

fn map_xai_response_event_to_codex(mut event: Value) -> Value {
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
}

fn map_xai_output_item_to_codex(item: &mut Value) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    if object.get("type").and_then(Value::as_str) != Some("function_call") {
        return;
    }
    if object.get("name").and_then(Value::as_str) != Some("apply_patch") {
        return;
    }
    let arguments = object
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let input = extract_apply_patch_input_from_arguments(&arguments);
    object.insert("type".to_owned(), Value::String("custom_tool_call".to_owned()));
    object.insert("input".to_owned(), Value::String(input));
    object.remove("arguments");
}

fn extract_apply_patch_input_from_arguments(arguments: &str) -> String {
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(trimmed) {
        if let Some(Value::String(input)) = map.get("input") {
            return input.clone();
        }
        if let Some(input) = map.get("input") {
            return input.to_string();
        }
    }
    // If the model emitted raw patch text as the entire arguments payload, keep it.
    if trimmed.contains("*** Begin Patch") {
        return trimmed.to_owned();
    }
    trimmed.to_owned()
}

fn transform_xai_sse_chunk(buffer: &mut String, chunk: &str) -> String {
    buffer.push_str(chunk);
    let mut output = String::new();
    while let Some(index) = buffer.find('\\n') {
        let mut line = buffer[..index].to_owned();
        if line.ends_with('\\r') {
            line.pop();
        }
        let rest = buffer[index + 1..].to_owned();
        *buffer = rest;
        if let Some(data) = line.strip_prefix("data:") {
            let payload = data.trim_start();
            if payload.is_empty() || payload == "[DONE]" {
                output.push_str(&line);
                output.push('\\n');
                continue;
            }
            if let Ok(event) = serde_json::from_str::<Value>(payload) {
                let mapped = map_xai_response_event_to_codex(event);
                match serde_json::to_string(&mapped) {
                    Ok(serialized) => {
                        output.push_str("data: ");
                        output.push_str(&serialized);
                        output.push('\\n');
                        continue;
                    }
                    Err(_) => {
                        output.push_str(&line);
                        output.push('\\n');
                        continue;
                    }
                }
            }
        }
        output.push_str(&line);
        output.push('\\n');
    }
    output
}`;

if (!src.includes(oldProject)) {
  console.error("project_xai_tool_schemas not found");
  process.exit(1);
}
src = src.replace(oldProject, newProject);

// Update forward_xai_response to transform stream
const oldForwardTail = `    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    for (name, value) in &headers {
        if is_end_to_end_response_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    Ok(response)
}`;

const newForwardTail = `    let status = upstream.status();
    let headers = upstream.headers().clone();
    let stream = upstream.bytes_stream();
    let mapped = futures_util::stream::unfold(
        (stream, String::new()),
        |(mut stream, mut carry)| async move {
            use futures_util::StreamExt;
            match stream.next().await {
                Some(Ok(bytes)) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    let mapped = transform_xai_sse_chunk(&mut carry, &chunk);
                    Some((
                        Ok::<_, reqwest::Error>(axum::body::Bytes::from(mapped.into_bytes())),
                        (stream, carry),
                    ))
                }
                Some(Err(error)) => Some((Err(error), (stream, carry))),
                None => {
                    if carry.is_empty() {
                        None
                    } else {
                        // Flush a trailing unterminated line without transformation.
                        let rest = std::mem::take(&mut carry);
                        Some((
                            Ok(axum::body::Bytes::from(rest.into_bytes())),
                            (stream, carry),
                        ))
                    }
                }
            }
        },
    );
    let mut response = Response::new(Body::from_stream(mapped));
    *response.status_mut() = status;
    for (name, value) in &headers {
        if is_end_to_end_response_header(name) {
            response.headers_mut().append(name.clone(), value.clone());
        }
    }
    Ok(response)
}`;

if (!src.includes(oldForwardTail)) {
  console.error("forward response tail not found");
  process.exit(1);
}
src = src.replace(oldForwardTail, newForwardTail);

// Update tests that assert null apply_patch
src = src.replace(
  `assert!(model["apply_patch_tool_type"].is_null());
        let instructions = model["base_instructions"].as_str().unwrap();
        assert!(instructions.contains("Shared tools"));
        assert!(instructions.contains("shell_command"));
        assert!(instructions.contains("view_image"));
        assert!(instructions.contains("update_plan"));
        assert!(instructions.contains("request_user_input"));
        assert!(instructions.contains("get_goal"));
        assert!(instructions.contains("update_goal"));
        assert!(instructions.contains("xiao_lsp_definition"));
        assert!(instructions.contains("xiao_runtime_diagnostics"));
        assert!(instructions.contains("xiao_preview_automate"));
        assert!(instructions.contains("Parallel tool calls are supported"));
        assert!(instructions.contains("If apply_patch is not listed"));`,
  `assert_eq!(model["apply_patch_tool_type"], "freeform");
        let instructions = model["base_instructions"].as_str().unwrap();
        assert!(instructions.contains("Shared tools"));
        assert!(instructions.contains("apply_patch"));
        assert!(instructions.contains("FREEFORM"));
        assert!(instructions.contains("shell_command"));
        assert!(instructions.contains("view_image"));
        assert!(instructions.contains("update_plan"));
        assert!(instructions.contains("request_user_input"));
        assert!(instructions.contains("get_goal"));
        assert!(instructions.contains("update_goal"));
        assert!(instructions.contains("xiao_lsp_definition"));
        assert!(instructions.contains("xiao_runtime_diagnostics"));
        assert!(instructions.contains("xiao_preview_automate"));
        assert!(instructions.contains("Parallel tool calls are supported"));
        assert!(instructions.contains("Prefer apply_patch over shell rewrites"));`
);

src = src.replace(
  `assert!(catalog["models"][0]["apply_patch_tool_type"].is_null());`,
  `assert_eq!(catalog["models"][0]["apply_patch_tool_type"], "freeform");`
);

// Extend the portable tools test with custom apply_patch projection
const oldToolsTestEnd = `        assert_eq!(
            sanitized["tools"][2]["parameters"]["properties"]["value"]["anyOf"],
            serde_json::json!([{ "type": "string" }, { "type": "null" }])
        );
        assert_eq!(
            sanitize_responses_request(sanitized.clone()).unwrap(),
            sanitized
        );
    }`;

const newToolsTestEnd = `        assert_eq!(
            sanitized["tools"][2]["parameters"]["properties"]["value"]["anyOf"],
            serde_json::json!([{ "type": "string" }, { "type": "null" }])
        );
        assert_eq!(
            sanitize_responses_request(sanitized.clone()).unwrap(),
            sanitized
        );
    }

    #[test]
    fn xai_responses_bridge_projects_freeform_apply_patch_to_function_tools() {
        let sanitized = sanitize_responses_request(serde_json::json!({
            "input": [
                {
                    "type": "custom_tool_call",
                    "call_id": "call-patch",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch"
                },
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call-patch",
                    "output": "Success"
                }
            ],
            "tools": [
                {
                    "type": "custom",
                    "name": "apply_patch",
                    "description": "The apply_patch tool can be used to edit files.",
                    "format": {
                        "type": "grammar",
                        "syntax": "lark",
                        "definition": "start: begin_patch"
                    }
                }
            ]
        }))
        .unwrap();

        assert_eq!(sanitized["tools"][0]["type"], "function");
        assert_eq!(sanitized["tools"][0]["name"], "apply_patch");
        assert_eq!(
            sanitized["tools"][0]["parameters"]["required"],
            serde_json::json!(["input"])
        );
        assert_eq!(sanitized["input"][0]["type"], "function_call");
        assert_eq!(sanitized["input"][0]["name"], "apply_patch");
        assert!(sanitized["input"][0]["arguments"]
            .as_str()
            .unwrap()
            .contains("*** Begin Patch"));
        assert_eq!(sanitized["input"][1]["type"], "function_call_output");
        assert_eq!(sanitized["input"][1]["output"], "Success");

        let mapped = map_xai_response_event_to_codex(serde_json::json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call-2",
                "name": "apply_patch",
                "arguments": "{\\"input\\":\\"*** Begin Patch\\\\n*** Add File: b.txt\\\\n+yo\\\\n*** End Patch\\"}"
            }
        }));
        assert_eq!(mapped["item"]["type"], "custom_tool_call");
        assert_eq!(
            mapped["item"]["input"],
            "*** Begin Patch\\n*** Add File: b.txt\\n+yo\\n*** End Patch"
        );
    }`;

if (!src.includes(oldToolsTestEnd)) {
  console.error("tools test end not found");
  process.exit(1);
}
src = src.replace(oldToolsTestEnd, newToolsTestEnd);

fs.writeFileSync(path, src);
console.log("service.rs updated");

// Add futures-util dependency
const cargoPath = "src-tauri/Cargo.toml";
let cargo = fs.readFileSync(cargoPath, "utf8");
if (!cargo.includes("futures-util")) {
  cargo = cargo.replace(
    `reqwest = { version = "0.12", default-features = false, features = ["blocking", "json", "rustls-tls", "stream"] }`,
    `futures-util = "0.3"\nreqwest = { version = "0.12", default-features = false, features = ["blocking", "json", "rustls-tls", "stream"] }`
  );
  fs.writeFileSync(cargoPath, cargo);
  console.log("Cargo.toml updated");
}
