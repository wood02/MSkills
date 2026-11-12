import { invoke } from "@tauri-apps/api/core";

export interface RtkStatus {
  installed: boolean;
  version?: string;
  binaryPath?: string;
  dbPath?: string;
  hasData: boolean;
}

export interface RtkDailyStat {
  date: string;
  savedTokens: number;
  outputTokens: number;
  inputTokens: number;
  commandCount: number;
}

export interface RtkGainSummary {
  totalCommands: number;
  totalSavedTokens: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  savingsPct: number;
  filteredCommands: number;
  filteredSavedTokens: number;
  filteredSavingsPct: number;
  dailyStats: RtkDailyStat[];
}

export interface RtkAgentItem {
  id: string;
  name: string;
  supported: boolean;
  unsupportedReason?: string;
  installed: boolean;
  enabled: boolean;
}

export const rtkApi = {
  async getStatus(): Promise<RtkStatus> {
    return await invoke<RtkStatus>("get_rtk_status");
  },

  async getStats(days?: number): Promise<RtkGainSummary> {
    return await invoke<RtkGainSummary>("get_rtk_stats", { days });
  },

  async getAgents(): Promise<RtkAgentItem[]> {
    return await invoke<RtkAgentItem[]>("get_rtk_agents");
  },

  async toggleAgent(agentId: string, enable: boolean): Promise<void> {
    return await invoke<void>("toggle_rtk_agent", { agentId, enable });
  },
};
