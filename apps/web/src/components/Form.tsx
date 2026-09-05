export function ErrorNotice({ message }: { message: string | null }) {
  return message ? (
    <p className="notice notice-error" role="alert">
      {message}
    </p>
  ) : null;
}
