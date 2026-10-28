import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

// 切页会卸载页面，筛选条件放在模块级，切回来还在；重启 app 后恢复默认
const store = new Map<string, unknown>();

export function useViewState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    store.has(key) ? (store.get(key) as T) : initial,
  );
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        store.set(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

export function resetViewState() {
  store.clear();
}
