export type MachineErrorCode =
  | "invalid_input"
  | "unsupported_ecosystem"
  | "evidence_unavailable"
  | "upstream_failure"
  | "rate_limited"
  | "payment_required"
  | "payment_invalid"
  | "payment_replay"
  | "payment_pending"
  | "payment_service_unavailable"
  | "identifier_conflict"
  | "service_unavailable"
  | "internal_error"
  | "not_found"
  | "unauthorized";

export interface MachineErrorBody {
  error: {
    code: MachineErrorCode | string;
    message: string;
    retryable: boolean;
    /** Compatibility alias for older clients; details remains canonical. */
    field?: string;
    details?: Record<string, unknown>;
  };
}

export function machineError(
  code: MachineErrorCode | string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): MachineErrorBody {
  return {
    error: {
      code,
      message,
      retryable,
      ...(typeof details?.field === "string" ? { field: details.field } : {}),
      ...(details ? { details } : {}),
    },
  };
}

export class MachineError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MachineErrorCode | string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toJSON(): MachineErrorBody {
    return machineError(this.code, this.message, this.retryable, this.details);
  }
}
