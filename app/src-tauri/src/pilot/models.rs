//! Which models an API key can use, asked of the vendor (#223).
//!
//! The pilot's API road offered `pilot.MODELS`, a list in the window's source -
//! `claude-opus-5`, `gpt-5` - which aged on the vendors' schedule rather than
//! ours: *"What if claude introduces a new model, we have to change source
//! code? I really want to avoid that."* Both vendors list the models a key may
//! use, for free, and that list is the answer.
//!
//! Here rather than in `src/` for the module header's reason - the key is here,
//! and the core keeps *every external call is a child process*. The CLI roads
//! ask their own CLI (`src/models.ts`).
//!
//! **Nothing is filtered.** OpenAI's listing includes models the chat API
//! cannot run, and the vendor gives no field that says which. Every rule that
//! could separate them is a list of names somebody would have to keep current,
//! which is the problem this exists to remove - so the listing is shown as the
//! vendor gave it, newest first, and a model that cannot chat says so when it
//! is picked.

use serde::Serialize;
use serde_json::Value;

use super::{agent, explain, redact, vendor, MAX_ERROR_BYTES};
use crate::keys::{self, Provider};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/models?limit=1000";
const OPENAI_URL: &str = "https://api.openai.com/v1/models";

/// One model, in the vendor's own words.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ApiModel {
    pub id: String,
    /// The vendor's display name; OpenAI has none, so it is the id.
    pub name: String,
}

/// The listing, newest first. `None` when the shape is not one this build reads.
pub fn parse(provider: Provider, body: &Value) -> Option<Vec<ApiModel>> {
    let data = body.get("data")?.as_array()?;
    let mut rows: Vec<(String, ApiModel)> = Vec::new();
    for m in data {
        let Some(id) = m.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            continue;
        };
        // The key a row sorts by: Anthropic's RFC 3339 time sorts as text, and
        // OpenAI's epoch seconds are padded so they do too.
        let (when, name) = match provider {
            Provider::Anthropic => (
                m.get("created_at").and_then(Value::as_str).unwrap_or("").to_string(),
                m.get("display_name").and_then(Value::as_str).unwrap_or(id).to_string(),
            ),
            Provider::Openai => (
                format!("{:020}", m.get("created").and_then(Value::as_u64).unwrap_or(0)),
                id.to_string(),
            ),
        };
        rows.push((when, ApiModel { id: id.to_string(), name }));
    }
    if rows.is_empty() {
        return None;
    }
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    Some(rows.into_iter().map(|(_, m)| m).collect())
}

fn list(provider: Provider) -> Result<Vec<ApiModel>, String> {
    let key = keys::read(provider)?;
    let agent = agent();
    let request = match provider {
        Provider::Anthropic => agent
            .get(ANTHROPIC_URL)
            .header("anthropic-version", super::anthropic::VERSION)
            .header("x-api-key", key.as_str()),
        Provider::Openai => agent.get(OPENAI_URL).header("authorization", format!("Bearer {key}")),
    };
    let response = request
        .call()
        .map_err(|e| format!("could not reach {}: {e}", vendor(provider)))?;
    let status = response.status();
    let mut body = response.into_body();
    let text = body
        .with_config()
        .limit(MAX_ERROR_BYTES * 64)
        .read_to_string()
        .map_err(|e| format!("{} sent a listing that could not be read: {e}", vendor(provider)))?;
    if !status.is_success() {
        // Redacted: OpenAI's 401 quotes the key it was sent, in full.
        return Err(redact(
            &format!("{} returned {}: {}", vendor(provider), status.as_u16(), explain(provider, &text)),
            &key,
        ));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("{} answered with something that is not JSON", vendor(provider)))?;
    parse(provider, &value).ok_or_else(|| format!("{} answered, but not with a list of models", vendor(provider)))
}

/// The models a stored key may use. On its own thread (`async`), because a
/// plain command runs on the main thread and this waits on the network.
#[tauri::command(async)]
pub fn pilot_models(provider: Provider) -> Result<Vec<ApiModel>, String> {
    list(provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn anthropic_is_read_with_its_display_names_newest_first() {
        let body = json!({"data": [
            {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-05-01T00:00:00Z"},
            {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "created_at": "2026-09-01T00:00:00Z"},
        ], "has_more": false});
        let models = parse(Provider::Anthropic, &body).unwrap();
        assert_eq!(models[0], ApiModel { id: "claude-fable-5-1".into(), name: "Claude Fable 5.1".into() });
        assert_eq!(models[1].id, "claude-opus-5");
    }

    #[test]
    fn openai_has_no_display_name_and_sorts_by_epoch_not_by_text() {
        let body = json!({"data": [
            {"id": "gpt-5", "created": 999},
            {"id": "gpt-6-astra", "created": 1000},
        ]});
        let ids: Vec<_> = parse(Provider::Openai, &body).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["gpt-6-astra", "gpt-5"]);
    }

    #[test]
    fn a_shape_that_is_not_a_listing_is_no_listing() {
        assert!(parse(Provider::Openai, &json!({"error": {}})).is_none());
        assert!(parse(Provider::Anthropic, &json!({"data": []})).is_none());
        assert!(parse(Provider::Anthropic, &json!({"data": [{"name": "no id"}]})).is_none());
    }
}
