/**
 * 仓库所有者头像 SWR（Stale-While-Revalidate）缓存模块
 * - L1 缓存：内存 Map（同会话内 0ms 读取）
 * - L2 缓存：localStorage（跨会话持久化，支持离线秒开）
 * - 缓存 TTL：1 天（24小时）
 * - 超过 TTL 后后台静默更新，平滑替换新头像
 */

import { useEffect, useState } from "react";

const STORAGE_PREFIX = "mskills:avatar:";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200; // 最多保留 200 个头像，防占用存储

interface CacheItem {
  dataUrl: string;
  timestamp: number;
}

// L1 内存缓存
const memoryCache = new Map<string, CacheItem>();

// 并发请求合并，避免列表渲染多个相同 owner 时重复发起网络请求
const pendingRequests = new Map<string, Promise<string | null>>();

// 监听缓存更新的事件总线，通知对应组件无感平滑切换
type AvatarListener = (dataUrl: string) => void;
const listeners = new Map<string, Set<AvatarListener>>();

function notifyListeners(owner: string, dataUrl: string) {
  const key = owner.toLowerCase();
  listeners.get(key)?.forEach((fn) => {
    try {
      fn(dataUrl);
    } catch (e) {
      console.error("Avatar listener error:", e);
    }
  });
}

/**
 * 从 localStorage 读取头像缓存
 */
function readFromStorage(owner: string): CacheItem | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${owner.toLowerCase()}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheItem;
    if (
      parsed &&
      typeof parsed.dataUrl === "string" &&
      typeof parsed.timestamp === "number"
    ) {
      return parsed;
    }
  } catch {
    // 忽略解析错误
  }
  return null;
}

/**
 * 写入 localStorage，并在超出配额或数量超过 MAX_CACHE_ENTRIES 时执行淘汰策略
 */
function writeToStorage(owner: string, item: CacheItem) {
  const key = `${STORAGE_PREFIX}${owner.toLowerCase()}`;

  const pruneOldEntries = () => {
    try {
      const keysToRemove: { key: string; timestamp: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          try {
            const raw = localStorage.getItem(k);
            if (raw) {
              const val = JSON.parse(raw);
              keysToRemove.push({ key: k, timestamp: val.timestamp || 0 });
            }
          } catch {
            keysToRemove.push({ key: k, timestamp: 0 });
          }
        }
      }

      if (keysToRemove.length >= MAX_CACHE_ENTRIES) {
        keysToRemove.sort((a, b) => a.timestamp - b.timestamp);
        // 清理前 25% 的旧条目
        const removeCount = Math.max(1, Math.floor(keysToRemove.length * 0.25));
        for (let i = 0; i < removeCount; i++) {
          localStorage.removeItem(keysToRemove[i].key);
        }
      }
    } catch {
      // 容错兜底
    }
  };

  try {
    pruneOldEntries();
    localStorage.setItem(key, JSON.stringify(item));
  } catch {
    // 如果超出浏览器配额，强制清理最早的 40%
    try {
      const keysToRemove: { key: string; timestamp: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push({ key: k, timestamp: 0 });
        }
      }
      const removeCount = Math.max(1, Math.floor(keysToRemove.length * 0.4));
      for (let i = 0; i < removeCount; i++) {
        localStorage.removeItem(keysToRemove[i].key);
      }
      localStorage.setItem(key, JSON.stringify(item));
    } catch {
      // 容错兜底
    }
  }
}

/**
 * 获取本地已缓存的头像（优先内存，其次 localStorage）
 */
export function getCachedAvatar(owner: string): {
  dataUrl: string | null;
  isStale: boolean;
} {
  const key = owner.toLowerCase();

  // 1. 尝试读 L1 内存
  let item = memoryCache.get(key);

  // 2. 尝试读 L2 localStorage
  if (!item) {
    const stored = readFromStorage(key);
    if (stored) {
      item = stored;
      memoryCache.set(key, stored);
    }
  }

  if (!item) {
    return { dataUrl: null, isStale: true };
  }

  const isStale = Date.now() - item.timestamp > ONE_DAY_MS;
  return { dataUrl: item.dataUrl, isStale };
}

/**
 * 异步下载头像并转为 Base64 Data URL
 */
async function fetchAvatarAsDataUrl(owner: string): Promise<string | null> {
  const key = owner.toLowerCase();
  if (pendingRequests.has(key)) {
    return pendingRequests.get(key)!;
  }

  const promise = (async () => {
    try {
      const url = `https://github.com/${owner}.png?size=80`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "image/*" },
      });

      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) {
        return null;
      }

      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    } finally {
      pendingRequests.delete(key);
    }
  })();

  pendingRequests.set(key, promise);
  return promise;
}

/**
 * 后台校验并更新头像（SWR 核心逻辑）
 */
export async function revalidateAvatar(
  owner: string,
  force = false,
): Promise<string | null> {
  const key = owner.toLowerCase();
  const cached = getCachedAvatar(owner);

  // 未过期且非强制刷新时直接跳过
  if (!cached.isStale && !force && cached.dataUrl) {
    return cached.dataUrl;
  }

  const newDataUrl = await fetchAvatarAsDataUrl(owner);
  if (newDataUrl) {
    const newItem: CacheItem = {
      dataUrl: newDataUrl,
      timestamp: Date.now(),
    };
    memoryCache.set(key, newItem);
    writeToStorage(key, newItem);
    notifyListeners(key, newDataUrl);
    return newDataUrl;
  } else if (cached.dataUrl) {
    // 遇到弱网或离线，保持现有老图，延后 1 小时再重试，防止反复刷请求
    const extendedItem: CacheItem = {
      dataUrl: cached.dataUrl,
      timestamp: Date.now() - ONE_DAY_MS + 60 * 60 * 1000,
    };
    memoryCache.set(key, extendedItem);
    writeToStorage(key, extendedItem);
  }

  return cached.dataUrl;
}

/**
 * React Hook：获取作者头像（带 SWR 1天缓存）
 */
export function useRepoAvatar(owner?: string) {
  const normalizedOwner = owner?.trim();

  // 同步初始化状态（如果有本地缓存，首帧直接拿到，0ms 无白屏）
  const [dataUrl, setDataUrl] = useState<string | null>(() => {
    if (!normalizedOwner) return null;
    return getCachedAvatar(normalizedOwner).dataUrl;
  });

  const [isLoading, setIsLoading] = useState<boolean>(() => {
    if (!normalizedOwner) return false;
    return !getCachedAvatar(normalizedOwner).dataUrl;
  });

  useEffect(() => {
    if (!normalizedOwner) {
      setDataUrl(null);
      setIsLoading(false);
      return;
    }

    const key = normalizedOwner.toLowerCase();
    const { dataUrl: initialData, isStale } = getCachedAvatar(normalizedOwner);

    if (initialData) {
      setDataUrl(initialData);
      setIsLoading(false);
    }

    // 订阅更新通知
    const listener: AvatarListener = (newUrl) => {
      setDataUrl(newUrl);
      setIsLoading(false);
    };

    if (!listeners.has(key)) {
      listeners.set(key, new Set());
    }
    listeners.get(key)!.add(listener);

    // 如果没有缓存或已超过 1 天，后台静默刷新
    if (!initialData || isStale) {
      revalidateAvatar(normalizedOwner).then((result) => {
        if (result) {
          setDataUrl(result);
        }
        setIsLoading(false);
      });
    }

    return () => {
      listeners.get(key)?.delete(listener);
      if (listeners.get(key)?.size === 0) {
        listeners.delete(key);
      }
    };
  }, [normalizedOwner]);

  return {
    dataUrl,
    isLoading,
  };
}
