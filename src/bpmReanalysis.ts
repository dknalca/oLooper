import type { BpmReanalysisScope } from "./tauri";

export interface BpmReanalysisRequest {
  scope: BpmReanalysisScope;
  label: string;
}

export function requestBpmReanalysis(scope: BpmReanalysisScope, label: string): void {
  window.dispatchEvent(new CustomEvent<BpmReanalysisRequest>("olooper:reanalyze-bpm", {
    detail: { scope, label },
  }));
}
