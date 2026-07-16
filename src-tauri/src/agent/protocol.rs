use serde_json::{json, Value};

pub fn initialize_request() -> Value {
    json!({
        "method": "initialize",
        "id": 0,
        "params": {
            "clientInfo": {
                "name": "xiao_workbench",
                "title": "Xiao Workbench",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true
            }
        }
    })
}

pub fn initialized_notification() -> Value {
    json!({ "method": "initialized", "params": {} })
}

pub fn request(id: u64, method: &str, params: Value) -> Value {
    if params.is_null() {
        json!({ "method": method, "id": id })
    } else {
        json!({ "method": method, "id": id, "params": params })
    }
}

pub fn response(id: Value, result: Value) -> Value {
    json!({ "id": id, "result": result })
}
