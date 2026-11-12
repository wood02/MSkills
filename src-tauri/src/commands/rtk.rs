use crate::services::rtk::{RtkAgentItem, RtkGainSummary, RtkService, RtkStatus};

#[tauri::command]
pub async fn get_rtk_status() -> Result<RtkStatus, String> {
    Ok(RtkService::get_status())
}

#[tauri::command]
pub async fn get_rtk_stats(days: Option<u32>) -> Result<RtkGainSummary, String> {
    RtkService::get_stats(days)
}

#[tauri::command]
pub async fn get_rtk_agents() -> Result<Vec<RtkAgentItem>, String> {
    Ok(RtkService::get_agents())
}

#[tauri::command]
pub async fn toggle_rtk_agent(agent_id: String, enable: bool) -> Result<(), String> {
    RtkService::toggle_agent(&agent_id, enable)
}
