import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

/** 技能组：一组 Skill id，不绑定应用，与项目 Profile 无关（后端 skill_groups 表） */
export interface SkillGroup {
  id: string;
  name: string;
  skills: string[];
  createdAt?: number;
}

export const skillGroupsApi = {
  async getCurrent(app: AppId): Promise<string | null> {
    return await invoke("get_current_skill_group", { app });
  },
  async list(): Promise<SkillGroup[]> {
    return await invoke("list_skill_groups");
  },

  /** 用 app 当前启用的 Skill 新建技能组 */
  async create(name: string, app: AppId): Promise<SkillGroup> {
    return await invoke("create_skill_group", { name, app });
  },

  async rename(id: string, name: string): Promise<SkillGroup> {
    return await invoke("rename_skill_group", { id, name });
  },

  async delete(id: string): Promise<void> {
    return await invoke("delete_skill_group", { id });
  },

  /** 让 app 的 Skill 启用状态与技能组一致，返回 warnings（best-effort） */
  async apply(id: string, app: AppId): Promise<string[]> {
    return await invoke("apply_skill_group", { id, app });
  },
};
