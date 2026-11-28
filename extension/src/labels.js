const connectionLabel = (connection) => {
  switch (connection?.status) {
    case "connected_last_verified":
      return "Connected";
    case "awaiting_sign_in":
      return "Sign in on the Naukri tab";
    case "session_expired":
      return "Sign in to Naukri again";
    case "action_required":
      return "Naukri needs you on the profile tab";
    case "account_changed":
      return "Confirm this is the right Naukri account";
    case "unable_to_verify":
      return "Could not open the Naukri profile";
    default:
      return "Not connected";
  }
};

const whenLabel = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
};

const slotWhen = (slotKey) => {
  const [day, time] = String(slotKey || "").split("|");
  if (!day || !time) return String(slotKey || "");
  const [year, month, date] = day.split("-").map(Number);
  const parsed = new Date(year, (month || 1) - 1, date || 1);
  if (Number.isNaN(parsed.getTime())) return `${day} ${time}`;
  const label = parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${label}, ${time}`;
};

const sizeLabel = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const slotStatusLabel = (status) => {
  const labels = {
    scheduled: "upcoming",
    due: "waiting",
    pending: "waiting",
    running: "running",
    success: "done",
    skipped_past_on_config: "skipped",
    skipped_coalesced: "skipped",
    skipped_overlap: "skipped",
    skipped_cooldown: "skipped",
    failed_retryable: "failed",
    failed_final: "failed",
  };
  return labels[status] || String(status || "scheduled").replace(/_/g, " ");
};

module.exports = {
  connectionLabel,
  whenLabel,
  slotWhen,
  sizeLabel,
  slotStatusLabel,
};
