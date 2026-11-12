import React, { useEffect, useState, useMemo } from "react";
import { RefreshCw, Copy, Check, Terminal, ExternalLink } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  rtkApi,
  type RtkStatus,
  type RtkGainSummary,
  type RtkAgentItem,
} from "@/lib/api/rtk";
import { ProviderIcon } from "@/components/ProviderIcon";
import { cn } from "@/lib/utils";

interface RtkDashboardProps {
  onBack?: () => void;
}

export const RtkDashboard: React.FC<RtkDashboardProps> = ({ onBack }) => {
  const [status, setStatus] = useState<RtkStatus | null>(null);
  const [stats, setStats] = useState<RtkGainSummary | null>(null);
  const [agents, setAgents] = useState<RtkAgentItem[]>([]);
  const [daysFilter, setDaysFilter] = useState<number>(30); // 30, 90, 0 (全部)
  const [loading, setLoading] = useState(true);
  const [togglingAgent, setTogglingAgent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadData = async (days = daysFilter) => {
    try {
      setLoading(true);
      const [newStatus, newAgents, newStats] = await Promise.all([
        rtkApi.getStatus(),
        rtkApi.getAgents(),
        rtkApi.getStats(days === 0 ? undefined : days),
      ]);
      setStatus(newStatus);
      setAgents(newAgents);
      setStats(newStats);
    } catch (err: any) {
      toast.error(`加载 RTK 数据失败: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData(daysFilter);
  }, [daysFilter]);

  const handleToggle = async (agentId: string, currentEnabled: boolean) => {
    try {
      setTogglingAgent(agentId);
      await rtkApi.toggleAgent(agentId, !currentEnabled);
      toast.success(
        !currentEnabled
          ? "已为该 Agent 启用 RTK 优化，切换后需重启对应 Agent"
          : "已关闭该 Agent 的 RTK Hook，需重启对应 Agent",
      );
      const updatedAgents = await rtkApi.getAgents();
      setAgents(updatedAgents);
    } catch (err: any) {
      toast.error(`配置失败: ${err?.message || err}`);
    } finally {
      setTogglingAgent(null);
    }
  };

  const handleCopyInstallCmd = () => {
    navigator.clipboard.writeText("brew install rtk");
    setCopied(true);
    toast.success("已复制安装命令到剪贴板");
    setTimeout(() => setCopied(false), 2000);
  };

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(1)}M`;
    }
    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}k`;
    }
    return tokens.toString();
  };

  const chartData = useMemo(() => {
    if (!stats || !stats.dailyStats) return [];
    return stats.dailyStats.map((item) => {
      // 提取 MM/DD 简短日期
      const parts = item.date.split("-");
      const shortDate =
        parts.length >= 3
          ? `${Number(parts[1])}/${Number(parts[2])}`
          : item.date;
      return {
        ...item,
        displayDate: shortDate,
      };
    });
  }, [stats]);

  // 根据 Agent ID 获取对应图标 Key
  const getAgentIconKey = (id: string): string => {
    switch (id) {
      case "claude":
        return "claude";
      case "codex":
        return "codex";
      case "antigravity":
        return "antigravity";
      case "cursor":
        return "cursor";
      case "gemini":
        return "gemini";
      case "opencode":
        return "opencode";
      case "pi":
        return "pi";
      case "hermes":
        return "hermes";
      case "droid":
        return "factory";
      case "dsh":
        return "deepseek";
      case "cline":
        return "cline";
      case "grokbuild":
        return "grok";
      case "kimi":
        return "kimi";
      default:
        return "custom";
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6 max-w-5xl mx-auto w-full">
      {/* 顶部路径与说明 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {onBack ? (
              <button
                onClick={onBack}
                className="hover:text-foreground transition-colors cursor-pointer"
              >
                提示词
              </button>
            ) : (
              <span>提示词</span>
            )}
            <span>/</span>
            <span className="text-foreground font-medium">RTK</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadData(daysFilter)}
            disabled={loading}
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
            title="刷新数据"
          >
            <RefreshCw
              className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")}
            />
            刷新
          </Button>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          RTK 改写 Agent 执行的命令行命令（git status、cargo
          test、ls……），只输出模型需要的部分，节省 token。为 Agent 打开后，运行
          RTK 自带的安装程序。
        </p>
      </div>

      {/* 未安装 RTK 状态引导卡片 */}
      {status && !status.installed && (
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-primary/10 text-primary rounded-lg">
              <Terminal className="w-6 h-6" />
            </div>
            <div className="space-y-1 flex-1">
              <h3 className="font-semibold text-base">未检测到 RTK</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                RTK (Rust Token Killer) 是一个高性能终端命令输出过滤器，专为 AI
                编程助手设计，可在执行 Bash/Git/Cargo
                等命令时智能裁剪无用输出，节约 60%~90% 的上下文 Token。
              </p>
            </div>
          </div>

          <div className="bg-muted/60 rounded-lg p-3.5 flex items-center justify-between text-xs font-mono border border-border/50">
            <span className="text-foreground select-all">brew install rtk</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCopyInstallCmd}
              className="h-7 px-2.5 text-xs gap-1.5 ml-3"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copied ? "已复制" : "复制命令"}
            </Button>
          </div>

          <div className="flex items-center justify-between pt-1">
            <a
              href="https://www.rtk-ai.app"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
            >
              了解更多关于 RTK <ExternalLink className="w-3 h-3" />
            </a>
            <Button
              size="sm"
              onClick={() => void loadData(daysFilter)}
              disabled={loading}
              className="text-xs"
            >
              <RefreshCw
                className={cn("w-3.5 h-3.5 mr-1.5", loading && "animate-spin")}
              />
              安装后重新检测
            </Button>
          </div>
        </div>
      )}

      {/* 已安装状态：图表与收益大盘 */}
      {status && status.installed && (
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm space-y-5">
          {/* 大盘头部：版本与文案 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center font-bold text-xs">
                  RTK
                </div>
                <span className="font-semibold text-base">RTK</span>
                <span className="text-xs text-muted-foreground font-mono">
                  {status.version || "v1.2.0"}
                </span>
                <Badge
                  variant="secondary"
                  className="text-[11px] font-normal px-2 py-0 h-5 bg-muted text-muted-foreground"
                >
                  已是最新
                </Badge>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {stats ? (
                <>
                  <span className="font-medium text-foreground">
                    {stats.totalCommands.toLocaleString()}
                  </span>{" "}
                  条命令共节省{" "}
                  <span className="font-medium text-foreground">
                    {formatTokens(stats.totalSavedTokens)}
                  </span>{" "}
                  token，平均省{" "}
                  <span className="font-medium text-foreground">
                    {stats.savingsPct.toFixed(0)}%
                  </span>{" "}
                  来自 RTK 自身的统计（rtk gain）：本机经过 RTK 的所有命令，不分
                  Agent 和终端。
                </>
              ) : (
                "正在读取本地统计..."
              )}
            </p>
          </div>

          {/* 堆叠柱状图卡片 */}
          <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-4">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-3">
                <span className="font-medium text-foreground">每日节省</span>
                <div className="flex items-center gap-1 bg-muted p-0.5 rounded-md text-[11px]">
                  <button
                    onClick={() => setDaysFilter(30)}
                    className={cn(
                      "px-2 py-0.5 rounded transition-all",
                      daysFilter === 30
                        ? "bg-background text-foreground shadow-xs font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    30 天
                  </button>
                  <button
                    onClick={() => setDaysFilter(90)}
                    className={cn(
                      "px-2 py-0.5 rounded transition-all",
                      daysFilter === 90
                        ? "bg-background text-foreground shadow-xs font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    90 天
                  </button>
                  <button
                    onClick={() => setDaysFilter(0)}
                    className={cn(
                      "px-2 py-0.5 rounded transition-all",
                      daysFilter === 0
                        ? "bg-background text-foreground shadow-xs font-medium"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    全部
                  </button>
                </div>
              </div>
            </div>

            {/* 图表主体 */}
            <div className="h-44 w-full">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      dataKey="displayDate"
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      stroke="var(--color-muted-foreground, #888888)"
                    />
                    <YAxis
                      width={48}
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      stroke="var(--color-muted-foreground, #888888)"
                      tickFormatter={formatTokens}
                    />
                    <Tooltip
                      cursor={{ fill: "currentColor", opacity: 0.06 }}
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const data = payload[0].payload;
                          return (
                            <div className="bg-popover text-popover-foreground text-xs p-2.5 rounded-lg border border-border shadow-md space-y-1 font-sans">
                              <p className="font-semibold">{data.date}</p>
                              <p className="text-[#6366f1]">
                                已节省: {data.savedTokens.toLocaleString()}{" "}
                                tokens
                              </p>
                              <p className="text-[#a5b4fc]">
                                发送给模型: {data.outputTokens.toLocaleString()}{" "}
                                tokens
                              </p>
                              <p className="text-muted-foreground pt-0.5 text-[11px]">
                                命令数: {data.commandCount}
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    {/* 仍发给模型 (浅色层) */}
                    <Bar
                      dataKey="outputTokens"
                      stackId="a"
                      fill="#a5b4fc"
                      radius={[0, 0, 0, 0]}
                    />
                    {/* 已节省 (深色层) */}
                    <Bar
                      dataKey="savedTokens"
                      stackId="a"
                      fill="#4f46e5"
                      radius={[3, 3, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  所选周期内暂无统计记录
                </div>
              )}
            </div>

            {/* 图表底部图例与当期统计 */}
            <div className="flex flex-wrap items-center justify-between text-xs text-muted-foreground pt-2 border-t border-border/40 gap-2">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-[#4f46e5]" />
                  <span>已节省</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-[#a5b4fc]" />
                  <span>仍发给模型</span>
                </div>
              </div>

              {stats && (
                <div>
                  <span className="text-foreground font-medium">
                    {stats.filteredCommands.toLocaleString()}
                  </span>{" "}
                  条命令节省{" "}
                  <span className="text-foreground font-medium">
                    {formatTokens(stats.filteredSavedTokens)}
                  </span>{" "}
                  token，省{" "}
                  <span className="text-foreground font-medium">
                    {stats.filteredSavingsPct.toFixed(0)}%
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 底部 AGENT 接入矩阵 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs px-1">
          <span className="font-semibold tracking-wider text-muted-foreground">
            AGENT
          </span>
          <span className="text-muted-foreground/75">
            切换后需重启对应 Agent
          </span>
        </div>

        <div className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden shadow-sm">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="flex items-center justify-between p-3.5 px-4.5 hover:bg-muted/20 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 flex items-center justify-center shrink-0">
                  <ProviderIcon
                    icon={getAgentIconKey(agent.id)}
                    name={agent.name}
                    size={22}
                  />
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">
                    {agent.name}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {!agent.supported && (
                  <Badge
                    variant="outline"
                    className="text-[11px] font-normal border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10 h-5 px-2"
                  >
                    ● {agent.unsupportedReason || "RTK 暂不支持"}
                  </Badge>
                )}

                <Switch
                  checked={agent.enabled}
                  disabled={
                    !agent.supported ||
                    !status?.installed ||
                    togglingAgent === agent.id
                  }
                  onCheckedChange={() =>
                    void handleToggle(agent.id, agent.enabled)
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
export default RtkDashboard;
