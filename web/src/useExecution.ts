import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, hasToken } from "./api";
import type { Receipt, RequestView, Status, TaskView } from "./api";

const saved = (key: string) => sessionStorage.getItem(`chatmaa.${key}`) ?? "";
export function useExecution() {
  const [status, setStatus] = useState<Status>();
  const [request, setRequest] = useState<RequestView>();
  const [task, setTask] = useState<TaskView>();
  const [connection, setConnection] = useState(
    hasToken
      ? "正在连接 Backend…"
      : "请使用 Backend 输出的本次启动地址打开页面。",
  );
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [stopState, setStopState] = useState("");
  const [stopping, setStopping] = useState(false);
  const [lastRead, setLastRead] = useState("");
  const requestId = useRef(saved("requestId"));
  const taskId = useRef(saved("taskId"));
  const eligible = useRef(""); // Deliberately not restored after refresh.
  const sendLock = useRef(false);
  const stopLock = useRef(false);
  const generation = useRef(0);
  const taskValue = useRef<TaskView | undefined>(undefined);
  function selectTask(value: TaskView) {
    if (value.state === "rejected") return;
    const old = taskValue.current;
    if (
      old &&
      old.id !== value.id &&
      (old.state !== "ended" ||
        !old.automation_stopped ||
        old.device !== "ready")
    )
      return;
    if (taskId.current !== value.id) {
      setStopState("");
      taskId.current = value.id;
      sessionStorage.setItem("chatmaa.taskId", value.id);
    }
    taskValue.current = value;
    setTask(value);
  }
  useEffect(() => {
    if (!hasToken) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const state = await api<Status>("/status");
        if (!alive) return;
        setStatus(state);
        setConnection("");
        if (!taskId.current && state.conflictingTaskIds.length) {
          taskId.current = state.conflictingTaskIds[0];
          sessionStorage.setItem("chatmaa.taskId", taskId.current);
        }
      } catch (error) {
        if (alive) setConnection(errorText(error));
      }
      const id = requestId.current;
      if (id) {
        try {
          const value = await api<RequestView>(
            `/requests/${encodeURIComponent(id)}`,
          );
          if (alive && id === requestId.current) {
            setRequest(value);
            if (value.task && value.task.id !== taskId.current)
              selectTask(value.task);
          }
        } catch (error) {
          if (alive && id === requestId.current) setNotice(errorText(error));
        }
      }
      const target = taskId.current;
      const version = generation.current;
      if (target) {
        try {
          const value = await api<TaskView>(
            `/tasks/${encodeURIComponent(target)}`,
          );
          if (
            alive &&
            target === taskId.current &&
            version === generation.current
          ) {
            selectTask(value);
            setLastRead(new Date().toLocaleTimeString());
          }
        } catch (error) {
          if (alive) setConnection(errorText(error));
        }
      }
      if (alive) timer = setTimeout(poll, 500);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  async function send(original: string) {
    if (sendLock.current || !original.trim()) return;
    sendLock.current = true;
    setSending(true);
    setNotice("");
    const previous = requestId.current;
    const previousEligible = eligible.current;
    const previousView = request;
    const id = crypto.randomUUID();
    requestId.current = id;
    eligible.current = id;
    sessionStorage.setItem("chatmaa.requestId", id);
    setRequest(undefined);
    try {
      const value = await api<RequestView>("/requests", {
        requestId: id,
        original,
        ...(taskId.current ? { targetId: taskId.current } : {}),
      });
      if (requestId.current === id) setRequest(value);
    } catch (error) {
      setNotice(errorText(error));
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        eligible.current = previousEligible;
        requestId.current = previous;
        setRequest(previousView);
        sessionStorage.setItem("chatmaa.requestId", previous);
      }
      // An uncertain response retains its ID for read-only reconciliation, never a new send.
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  async function displayed(id: string, receipt: Receipt) {
    if (eligible.current !== id) return;
    try {
      await api(
        `/requests/${encodeURIComponent(id)}/summary-displayed`,
        receipt,
      );
    } catch (error) {
      setNotice(errorText(error));
    }
  }
  async function stop() {
    const id = taskId.current;
    if (!id || stopLock.current) return;
    stopLock.current = true;
    setStopping(true);
    generation.current++;
    setStopState("正在请求停止…");
    try {
      const result = await api<{ delivered?: boolean; confirmed: boolean }>(
        `/tasks/${encodeURIComponent(id)}/stop`,
        {},
      );
      setStopState(
        result.confirmed
          ? "执行端已确认停止自动化。"
          : result.delivered === false
            ? "停止传达尚未确认，继续读取执行证据。"
            : "停止请求已受理，等待执行端确认。",
      );
    } catch (error) {
      setStopState(`停止结果尚未确认。${errorText(error)}`);
    } finally {
      generation.current++;
      stopLock.current = false;
      setStopping(false);
    }
  }
  return {
    status,
    request,
    task,
    connection,
    notice,
    sending,
    stopping,
    stopState,
    lastRead,
    send,
    stop,
    displayed,
    canAcknowledge: !!request && eligible.current === request.record.requestId,
  };
}
