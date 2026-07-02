export type InstanceState =
  | "CREATED"
  | "CONNECTING"
  | "QR_PENDING"
  | "ACTIVE"
  | "DEGRADED"
  | "COOLDOWN"
  | "BLOCKED"
  | "BANNED";

export type InstanceStateTrigger =
  | "start_requested"
  | "qr_required"
  | "passkey_required"
  | "session_restored"
  | "qr_scanned"
  | "qr_expired"
  | "health_degraded"
  | "health_recovered"
  | "risk_elevated"
  | "risk_critical"
  | "cooldown_finished"
  | "manual_block"
  | "manual_unblock"
  | "ban_confirmed";

const transitions: Record<InstanceState, Partial<Record<InstanceStateTrigger, InstanceState>>> = {
  CREATED: {
    start_requested: "CONNECTING"
  },
  CONNECTING: {
    qr_required: "QR_PENDING",
    passkey_required: "QR_PENDING",
    session_restored: "ACTIVE",
    health_degraded: "DEGRADED",
    ban_confirmed: "BANNED"
  },
  QR_PENDING: {
    qr_scanned: "ACTIVE",
    qr_expired: "COOLDOWN",
    ban_confirmed: "BANNED"
  },
  ACTIVE: {
    health_degraded: "DEGRADED",
    risk_elevated: "COOLDOWN",
    risk_critical: "BLOCKED",
    manual_block: "BLOCKED",
    ban_confirmed: "BANNED"
  },
  DEGRADED: {
    health_recovered: "ACTIVE",
    risk_elevated: "COOLDOWN",
    risk_critical: "BLOCKED",
    ban_confirmed: "BANNED"
  },
  COOLDOWN: {
    cooldown_finished: "ACTIVE",
    risk_critical: "BLOCKED",
    manual_block: "BLOCKED",
    ban_confirmed: "BANNED"
  },
  BLOCKED: {
    manual_unblock: "COOLDOWN",
    ban_confirmed: "BANNED"
  },
  BANNED: {}
};

export function normalizeInstanceState(status?: string | null): InstanceState {
  const value = String(status || "").toLowerCase();
  if (["created", "none", "logged_out"].includes(value)) return "CREATED";
  if (["connecting", "reconnecting"].includes(value)) return "CONNECTING";
  if (["qr", "qr_pending", "qr_expired", "passkey_required", "passkey_confirmation"].includes(value)) return "QR_PENDING";
  if (["open", "connected", "active"].includes(value)) return "ACTIVE";
  if (["degraded", "error", "disconnected", "close"].includes(value)) return "DEGRADED";
  if (["cooldown", "paused"].includes(value)) return "COOLDOWN";
  if (["blocked"].includes(value)) return "BLOCKED";
  if (["banned"].includes(value)) return "BANNED";
  return "CREATED";
}

export function publicStatusFromState(state: InstanceState) {
  const map: Record<InstanceState, string> = {
    CREATED: "created",
    CONNECTING: "connecting",
    QR_PENDING: "qr_pending",
    ACTIVE: "connected",
    DEGRADED: "degraded",
    COOLDOWN: "paused",
    BLOCKED: "blocked",
    BANNED: "banned"
  };
  return map[state];
}

export function transitionInstanceState(current: InstanceState, trigger: InstanceStateTrigger) {
  const next = transitions[current]?.[trigger];
  return {
    allowed: Boolean(next),
    current,
    trigger,
    next: next || current
  };
}

export function getInstanceStateMachine() {
  return transitions;
}
