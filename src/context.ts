import type { CallerIdentity } from "./telemetry";

export interface AppVariables {
  caller: CallerIdentity;
  requestId: string;
  startedAt: number;
  meta?: { ecosystem?: string; package?: string };
  cacheHit?: boolean;
  unknownResult?: boolean;
  mcpTool?: string;
  mcpIsError?: boolean;
}
