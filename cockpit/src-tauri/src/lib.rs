use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsSettings {
  pub vm_host: String,
  pub vm_user: String,
  pub vm_path: String,
  pub ssh_key_path: String,
  pub local_repo_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsCommand {
  PrepareAndStartLive,
  StopBot,
  GitPull,
  SyncEnvProduction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpsCommandResult {
  pub ok: bool,
  pub command: OpsCommand,
  pub message: String,
  pub detail: Option<String>,
  pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
  pub ok: bool,
  pub message: String,
  pub bot_running: Option<bool>,
  pub git_head: Option<String>,
  pub detail: Option<String>,
  pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshotResult {
  pub ok: bool,
  pub message: String,
  pub summary_json: Option<String>,
  pub healthz_json: Option<String>,
  pub status_json: Option<String>,
  pub bot_running: Option<bool>,
  pub detail: Option<String>,
  pub at: String,
}

fn now_iso() -> String {
  use std::time::{SystemTime, UNIX_EPOCH};
  let secs = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  format!("{secs}")
}

fn validate_settings(settings: &OpsSettings) -> Result<(), String> {
  if settings.vm_host.trim().is_empty() {
    return Err("vmHost is required".into());
  }
  if settings.vm_user.trim().is_empty() {
    return Err("vmUser is required".into());
  }
  if settings.vm_path.trim().is_empty() {
    return Err("vmPath is required".into());
  }
  if settings.ssh_key_path.trim().is_empty() {
    return Err("sshKeyPath is required for SSH ops".into());
  }
  if !std::path::Path::new(&settings.ssh_key_path).exists() {
    return Err(format!("SSH key not found: {}", settings.ssh_key_path));
  }
  Ok(())
}

fn ssh_base(settings: &OpsSettings) -> Command {
  let mut cmd = Command::new("ssh");
  cmd
    .arg("-i")
    .arg(&settings.ssh_key_path)
    .arg("-o")
    .arg("BatchMode=yes")
    .arg("-o")
    .arg("StrictHostKeyChecking=accept-new")
    .arg(format!("{}@{}", settings.vm_user, settings.vm_host));
  cmd
}

fn run_ssh(settings: &OpsSettings, remote: &str) -> Result<String, String> {
  run_ssh_with_timeout(settings, remote, None)
}

fn run_ssh_with_timeout(
  settings: &OpsSettings,
  remote: &str,
  timeout: Option<Duration>,
) -> Result<String, String> {
  let mut cmd = ssh_base(settings);
  if let Some(limit) = timeout {
    let secs = limit.as_secs().max(1).to_string();
    cmd.arg("-o").arg(format!("ConnectTimeout={secs}"));
    // OpenSSH ServerAlive* keeps the session from hanging forever on a stuck remote.
    cmd.arg("-o").arg("ServerAliveInterval=5");
    cmd.arg("-o").arg("ServerAliveCountMax=6");
  }
  let output = cmd
    .arg(remote)
    .output()
    .map_err(|e| format!("failed to spawn ssh: {e}"))?;
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if output.status.success() {
    Ok(if stdout.is_empty() { stderr } else { stdout })
  } else {
    Err(if stderr.is_empty() { stdout } else { stderr })
  }
}

fn run_scp(settings: &OpsSettings, local_file: &str, remote_name: &str) -> Result<String, String> {
  let local = std::path::Path::new(&settings.local_repo_path).join(local_file);
  if !local.exists() {
    return Err(format!("local env file missing: {}", local.display()));
  }
  let remote = format!(
    "{}@{}:{}/{}",
    settings.vm_user, settings.vm_host, settings.vm_path, remote_name
  );
  let output = Command::new("scp")
    .arg("-i")
    .arg(&settings.ssh_key_path)
    .arg("-o")
    .arg("BatchMode=yes")
    .arg(local.as_os_str())
    .arg(&remote)
    .output()
    .map_err(|e| format!("failed to spawn scp: {e}"))?;
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
  if output.status.success() {
    Ok(format!("synced {local_file} -> {remote_name}"))
  } else {
    Err(stderr)
  }
}

fn remote_script(settings: &OpsSettings, script: &str) -> String {
  format!(
    "cd {} && chmod +x {} 2>/dev/null; bash {}",
    settings.vm_path, script, script
  )
}

fn shell_quote(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

fn parse_bot_running(status_json: &str) -> Option<bool> {
  let trimmed = status_json.trim();
  if trimmed.is_empty() || trimmed == "{}" {
    return None;
  }
  // Lightweight parse — avoid pulling serde_json for a single bool.
  if trimmed.contains("\"lockHolderAlive\":true") || trimmed.contains("\"lockHolderAlive\": true") {
    return Some(true);
  }
  if trimmed.contains("\"lockHolderAlive\":false") || trimmed.contains("\"lockHolderAlive\": false")
  {
    return Some(false);
  }
  None
}

fn execute(command: OpsCommand, settings: &OpsSettings) -> Result<String, String> {
  validate_settings(settings)?;
  match command {
    OpsCommand::PrepareAndStartLive => {
      let receipt = format!(
        "cd {} && npm run dry-run:receipt:event-purity-production",
        settings.vm_path
      );
      let receipt_out = run_ssh(settings, &receipt)?;
      let start_out = run_ssh(
        settings,
        &remote_script(settings, "./start-event-purity-production.sh"),
      )?;
      Ok(format!("{receipt_out}\n{start_out}"))
    }
    OpsCommand::StopBot => {
      let cmd = format!("cd {} && npm run bot:stop", settings.vm_path);
      run_ssh(settings, &cmd)
    }
    OpsCommand::GitPull => {
      // Laptop pushes to GitHub manually; cockpit only fast-forwards the VM clone.
      let cmd = format!(
        "cd {} && git pull --ff-only && git rev-parse --short HEAD",
        settings.vm_path
      );
      run_ssh(settings, &cmd)
    }
    OpsCommand::SyncEnvProduction => {
      if settings.local_repo_path.trim().is_empty() {
        return Err("localRepoPath is required for env sync".into());
      }
      // Exact operator sequence: SCP production profile, then activate as .env on VM.
      let scp_out = run_scp(
        settings,
        ".env.event-purity-production",
        ".env.event-purity-production",
      )?;
      let activate = format!(
        "cd {} && cp .env.event-purity-production .env",
        settings.vm_path
      );
      let cp_out = run_ssh(settings, &activate)?;
      Ok(format!("{scp_out}\n{cp_out}"))
    }
  }
}

fn test_connection(settings: &OpsSettings) -> Result<(String, Option<bool>, Option<String>), String> {
  validate_settings(settings)?;
  let path = shell_quote(&settings.vm_path);
  let remote = format!(
    "echo ok && cd {path} && test -d . && \
     (git rev-parse --short HEAD 2>/dev/null || echo unknown) && \
     echo '---COCKPIT---' && \
     (npm run -s bot:status 2>/dev/null || node scripts/ensure-single-bot.mjs --status 2>/dev/null || echo '{{}}')"
  );
  let out = run_ssh_with_timeout(settings, &remote, Some(Duration::from_secs(30)))?;
  let parts: Vec<&str> = out.split("---COCKPIT---").collect();
  let preamble = parts.first().map(|s| s.trim()).unwrap_or("");
  let status_blob = parts.get(1).map(|s| s.trim()).unwrap_or("{}");

  let mut lines = preamble.lines().map(str::trim).filter(|l| !l.is_empty());
  let first = lines.next().unwrap_or("");
  if first != "ok" {
    return Err(format!("unexpected SSH preamble: {preamble}"));
  }
  let git_head = lines.next().map(|s| s.to_string());
  let bot_running = parse_bot_running(status_blob);
  Ok((out, bot_running, git_head))
}

fn fetch_snapshot(settings: &OpsSettings) -> Result<(String, String, String, Option<bool>), String> {
  validate_settings(settings)?;
  let path = shell_quote(&settings.vm_path);
  let remote = format!(
    "cd {path} && \
     LOG=$(node scripts/resolve-active-session-log.mjs 2>/dev/null || true) && \
     if [ -z \"$LOG\" ] || [ ! -f \"$LOG\" ]; then \
       LOG=$(ls -t logs/event-purity-*.log logs/*.log 2>/dev/null | head -1 || true); \
     fi && \
     if [ -n \"$LOG\" ] && [ -f \"$LOG\" ]; then \
       OUT=$(node scripts/watch-bot-summary.mjs \"$LOG\" --json 2>/dev/null || true); \
       if [ -n \"$OUT\" ]; then printf '%s\\n' \"$OUT\"; else echo '{{}}'; fi; \
     else \
       echo '{{}}'; \
     fi && \
     echo '---COCKPIT---' && \
     (curl -sf --max-time 3 http://127.0.0.1:9090/healthz 2>/dev/null || echo '{{}}') && \
     echo '---COCKPIT---' && \
     (curl -sf --max-time 3 http://127.0.0.1:9090/status 2>/dev/null || echo '{{}}') && \
     echo '---COCKPIT---' && \
     (node scripts/ensure-single-bot.mjs --status 2>/dev/null || echo '{{}}')"
  );
  let out = run_ssh_with_timeout(settings, &remote, Some(Duration::from_secs(30)))?;
  let parts: Vec<&str> = out.split("---COCKPIT---").collect();
  let summary = parts.first().map(|s| s.trim().to_string()).unwrap_or_else(|| "{}".into());
  let healthz = parts
    .get(1)
    .map(|s| s.trim().to_string())
    .unwrap_or_else(|| "{}".into());
  let status = parts
    .get(2)
    .map(|s| s.trim().to_string())
    .unwrap_or_else(|| "{}".into());
  let bot_status = parts.get(3).map(|s| s.trim()).unwrap_or("{}");
  let bot_running = parse_bot_running(bot_status);
  Ok((summary, healthz, status, bot_running))
}

#[tauri::command]
fn run_ops_command(command: OpsCommand, settings: OpsSettings) -> OpsCommandResult {
  match execute(command.clone(), &settings) {
    Ok(detail) => OpsCommandResult {
      ok: true,
      command,
      message: "Command completed".into(),
      detail: Some(detail),
      at: now_iso(),
    },
    Err(err) => OpsCommandResult {
      ok: false,
      command,
      message: err,
      detail: None,
      at: now_iso(),
    },
  }
}

#[tauri::command]
fn test_vm_connection(settings: OpsSettings) -> ConnectionTestResult {
  match test_connection(&settings) {
    Ok((detail, bot_running, git_head)) => ConnectionTestResult {
      ok: true,
      message: match bot_running {
        Some(true) => "Connected — bot RUNNING".into(),
        Some(false) => "Connected — bot OFF".into(),
        None => "Connected".into(),
      },
      bot_running,
      git_head,
      detail: Some(detail),
      at: now_iso(),
    },
    Err(err) => ConnectionTestResult {
      ok: false,
      message: err,
      bot_running: None,
      git_head: None,
      detail: None,
      at: now_iso(),
    },
  }
}

#[tauri::command]
fn fetch_telemetry_snapshot(settings: OpsSettings) -> TelemetrySnapshotResult {
  match fetch_snapshot(&settings) {
    Ok((summary_json, healthz_json, status_json, bot_running)) => TelemetrySnapshotResult {
      ok: true,
      message: "Telemetry snapshot ok".into(),
      summary_json: Some(summary_json),
      healthz_json: Some(healthz_json),
      status_json: Some(status_json),
      bot_running,
      detail: None,
      at: now_iso(),
    },
    Err(err) => TelemetrySnapshotResult {
      ok: false,
      message: err,
      summary_json: None,
      healthz_json: None,
      status_json: None,
      bot_running: None,
      detail: None,
      at: now_iso(),
    },
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn validate_settings_rejects_missing_key() {
    let settings = OpsSettings {
      vm_host: "143.47.121.38".into(),
      vm_user: "ubuntu".into(),
      vm_path: "/home/ubuntu/liquidator".into(),
      ssh_key_path: String::new(),
      local_repo_path: String::new(),
    };
    let err = validate_settings(&settings).unwrap_err();
    assert!(err.contains("sshKeyPath"));
  }

  #[test]
  fn validate_settings_rejects_nonexistent_key() {
    let settings = OpsSettings {
      vm_host: "143.47.121.38".into(),
      vm_user: "ubuntu".into(),
      vm_path: "/home/ubuntu/liquidator".into(),
      ssh_key_path: "C:\\does\\not\\exist.key".into(),
      local_repo_path: String::new(),
    };
    let err = validate_settings(&settings).unwrap_err();
    assert!(err.contains("SSH key not found"));
  }

  #[test]
  fn parse_bot_running_reads_lock_holder() {
    assert_eq!(
      parse_bot_running(r#"{"lockHolderAlive":true,"count":1}"#),
      Some(true)
    );
    assert_eq!(
      parse_bot_running(r#"{"lockHolderAlive": false}"#),
      Some(false)
    );
    assert_eq!(parse_bot_running("{}"), None);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      run_ops_command,
      test_vm_connection,
      fetch_telemetry_snapshot
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
