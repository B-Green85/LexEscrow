//! Notification layer — post-settlement client notification only.
//!
//! Email via SMTP (lettre) and optional SMS via the Twilio REST API (reqwest).
//! Both are configured from environment variables; when a channel is not
//! configured the call is reported as `skipped` (nothing is ever sent before
//! funds move, and the audit log records the true delivery status).

use serde::{Deserialize, Serialize};
use tauri::State;

use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::vault::{SmtpEntry, TwilioEntry, VaultState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyRequest {
    pub channel: String, // "email" | "sms"
    pub to: String,
    pub client_name: String,
    pub amount_cents: i64,
    pub reference: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyResult {
    pub channel: String,
    pub target: String,
    pub status: String, // "sent" | "delivered" | "skipped" | "failed"
}

impl NotifyResult {
    fn new(channel: &str, target: &str, status: &str) -> Self {
        Self {
            channel: channel.to_string(),
            target: target.to_string(),
            status: status.to_string(),
        }
    }
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn env_or(key: &str, default: &str) -> String {
    env(key).unwrap_or_else(|| default.to_string())
}

/// Integer cents → `$1,234.56` with thousands separators (no floating point).
fn format_usd(cents: i64) -> String {
    let negative = cents < 0;
    let abs = cents.unsigned_abs();
    let dollars = abs / 100;
    let rem = abs % 100;
    let digits = dollars.to_string();
    let mut grouped = String::new();
    let bytes = digits.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(*b as char);
    }
    format!("{}${}.{:02}", if negative { "-" } else { "" }, grouped, rem)
}

/// `0x7f3a…c91b` short reference.
fn short_ref(reference: &str) -> String {
    if reference.len() <= 12 {
        return reference.to_string();
    }
    format!("{}…{}", &reference[..6], &reference[reference.len() - 4..])
}

fn today() -> String {
    // e.g. "October 15, 2026"
    chrono::Utc::now().format("%B %-d, %Y").to_string()
}

async fn send_email(req: &NotifyRequest, vault_smtp: Option<SmtpEntry>) -> NotifyResult {
    let skipped = NotifyResult::new("email", &req.to, "skipped");

    // Prefer vault credentials; fall back to environment variables.
    let (host, port, username, password, from) = match vault_smtp {
        Some(s) if !s.host.is_empty() => {
            let from = env("SMTP_FROM").unwrap_or_else(|| s.username.clone());
            (s.host, s.port, s.username, s.password, from)
        }
        _ => match env("SMTP_HOST") {
            Some(host) => (
                host,
                env_or("SMTP_PORT", "587").parse().unwrap_or(587),
                env_or("SMTP_USERNAME", ""),
                env_or("SMTP_PASSWORD", ""),
                env_or("SMTP_FROM", "no-reply@lawfirm.example"),
            ),
            None => return skipped,
        },
    };
    let firm = env_or("LAW_FIRM_NAME", "Your Law Firm");
    let amount = format_usd(req.amount_cents);
    let reference = short_ref(&req.reference);

    let subject = "Your Retainer Release Has Been Processed";
    let body = format!(
        "{name},\n\n\
         Your retainer release has been processed and your funds are on their way.\n\n\
         Amount: {amount}\n\
         Reference: {reference}\n\
         Date: {date}\n\n\
         Please allow 1 to 3 business days for funds to appear in your account.\n\n\
         {firm}\n",
        name = req.client_name,
        amount = amount,
        reference = reference,
        date = today(),
        firm = firm,
    );

    let message = match (from.parse(), req.to.parse()) {
        (Ok(from_mbox), Ok(to_mbox)) => Message::builder()
            .from(from_mbox)
            .to(to_mbox)
            .subject(subject)
            .body(body),
        _ => return NotifyResult::new("email", &req.to, "failed"),
    };
    let email = match message {
        Ok(m) => m,
        Err(_) => return NotifyResult::new("email", &req.to, "failed"),
    };

    let mut builder = match AsyncSmtpTransport::<Tokio1Executor>::relay(&host) {
        Ok(b) => b.port(port),
        Err(_) => return NotifyResult::new("email", &req.to, "failed"),
    };
    if !username.is_empty() {
        builder = builder.credentials(Credentials::new(username, password));
    }
    let mailer = builder.build();

    match mailer.send(email).await {
        Ok(_) => NotifyResult::new("email", &req.to, "sent"),
        Err(e) => {
            eprintln!("SMTP send failed: {e}");
            NotifyResult::new("email", &req.to, "failed")
        }
    }
}

async fn send_sms(req: &NotifyRequest, vault_twilio: Option<TwilioEntry>) -> NotifyResult {
    let skipped = NotifyResult::new("sms", &req.to, "skipped");

    // Prefer vault credentials; fall back to environment variables.
    let (sid, token, from) = match vault_twilio {
        Some(t) if !t.account_sid.is_empty() && !t.from_number.is_empty() => {
            (t.account_sid, t.auth_token, t.from_number)
        }
        _ => {
            let sid = match env("TWILIO_ACCOUNT_SID") {
                Some(s) => s,
                None => return skipped,
            };
            let from = match env("TWILIO_FROM") {
                Some(f) => f,
                None => return skipped,
            };
            (sid, env_or("TWILIO_AUTH_TOKEN", ""), from)
        }
    };
    let firm = env_or("LAW_FIRM_NAME", "Your Law Firm");
    let amount = format_usd(req.amount_cents);
    let reference = short_ref(&req.reference);

    let body = format!(
        "{firm}: Your retainer release of {amount} has been processed. Ref: {reference}. \
         Please allow 1-3 business days for funds to appear in your account."
    );

    let url = format!("https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json");
    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .basic_auth(&sid, Some(&token))
        .form(&[("From", from.as_str()), ("To", req.to.as_str()), ("Body", body.as_str())])
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => NotifyResult::new("sms", &req.to, "sent"),
        Ok(r) => {
            eprintln!("Twilio send failed: HTTP {}", r.status());
            NotifyResult::new("sms", &req.to, "failed")
        }
        Err(e) => {
            eprintln!("Twilio request failed: {e}");
            NotifyResult::new("sms", &req.to, "failed")
        }
    }
}

/// Post-settlement client notification. Dispatched by the workflow only after
/// CRE confirms settlement — never before funds move.
#[tauri::command]
pub async fn send_client_notification(
    vault: State<'_, VaultState>,
    request: NotifyRequest,
) -> Result<NotifyResult, String> {
    let smtp = vault.resolve_smtp();
    let twilio = vault.resolve_twilio();
    match request.channel.as_str() {
        "email" => Ok(send_email(&request, smtp).await),
        "sms" => Ok(send_sms(&request, twilio).await),
        other => Err(format!("unknown notification channel: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_usd_with_grouping() {
        assert_eq!(format_usd(420000), "$4,200.00");
        assert_eq!(format_usd(0), "$0.00");
        assert_eq!(format_usd(100050), "$1,000.50");
        assert_eq!(format_usd(123456789), "$1,234,567.89");
    }

    #[test]
    fn shortens_reference() {
        assert_eq!(short_ref("0x7f3a1b2c3d4e5f60c91b"), "0x7f3a…c91b");
        assert_eq!(short_ref("0x1234"), "0x1234");
    }
}
