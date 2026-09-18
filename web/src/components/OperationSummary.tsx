import { useEffect, useRef } from "react";
import type { Receipt } from "../api";

export function OperationSummary({
  text,
  requestId,
  receipt,
  eligible,
  displayed,
}: {
  text: string;
  requestId: string;
  receipt: Receipt | null;
  eligible: boolean;
  displayed: (id: string, receipt: Receipt) => Promise<"done" | "retry">;
}) {
  const element = useRef<HTMLElement>(null);
  const receiptId = receipt?.receiptId;
  const operationId = receipt?.operationId;
  useEffect(() => {
    if (!eligible || !receiptId || !operationId) return;
    let frame = 0;
    let cancelled = false;
    let sent = false;
    let inFlight = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 60000;
    function schedule() {
      if (
        document.visibilityState !== "visible" ||
        cancelled ||
        sent ||
        inFlight ||
        Date.now() >= deadline
      )
        return;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      element.current?.scrollIntoView({ block: "nearest" });
      // Two frames give the committed visible summary a paint opportunity.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const bounds = element.current?.getBoundingClientRect();
          if (
            cancelled ||
            document.visibilityState !== "visible" ||
            !bounds ||
            bounds.bottom <= 0 ||
            bounds.top >= innerHeight
          )
            return;
          inFlight = true;
          void displayed(requestId, {
            receiptId: receiptId!,
            operationId: operationId!,
          }).then((result) => {
            inFlight = false;
            if (cancelled) return;
            sent = result === "done";
            if (!sent) retry = setTimeout(schedule, 1000);
          });
        });
      });
    }
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", schedule);
    };
    // Retry only this receipt; polling removes it when accepted or expired.
  }, [requestId, receiptId, operationId, eligible]);
  return (
    <section ref={element} className="summary" aria-label="操作摘要">
      <span className="eyebrow">操作摘要</span>
      <p>{text}</p>
      {receipt && (
        <small>
          {eligible
            ? "摘要展示后自动继续，无需再次确认。"
            : "这是只读恢复的摘要，不会自动补发回执或执行。"}
        </small>
      )}
    </section>
  );
}
