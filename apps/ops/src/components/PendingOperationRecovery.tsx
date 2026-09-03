export function PendingOperationRecovery({
  action,
  busy,
  onConfirm,
  title,
}: {
  action: string;
  busy: boolean;
  onConfirm: () => void;
  title: string;
}) {
  return (
    <section className="publish-confirmation catalog-publish" aria-live="polite">
      <h2>{title}</h2>
      <button className="primary" disabled={busy} type="button" onClick={onConfirm}>
        {busy ? "Confirming…" : action}
      </button>
    </section>
  );
}
