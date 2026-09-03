import type { EditingSurface } from "../hooks/useEditingPresence";
import type { CurrentTeamMember } from "../types";

type Editor = {
  membershipId: CurrentTeamMember["membershipId"];
  surface: EditingSurface;
  label: string;
};

export function EditingPresence({
  editors,
  members,
}: {
  editors: readonly Editor[];
  members: readonly CurrentTeamMember[];
}) {
  if (editors.length === 0) return null;

  const activeEditors = [
    ...new Map(
      editors.map((editor) => {
        const name = members.find(
          (member) => member.membershipId === editor.membershipId,
        )?.displayName;
        const label = name
          ? `${name} is editing ${editor.label}`
          : `Someone is editing ${editor.label}`;
        return [`${editor.membershipId}:${editor.surface}:${editor.label}`, label] as const;
      }),
    ).values(),
  ];

  return (
    <p
      role="status"
      aria-live="polite"
      className="-mt-1.5 mb-4.5 flex flex-wrap items-center justify-center gap-2 text-[11.5px] text-rose-light"
    >
      {activeEditors.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1.5 rounded-full border border-rose-light/25 bg-rose-light/8 px-2.5 py-1"
        >
          <span
            aria-hidden="true"
            className="size-[5px] flex-none animate-dot-pulse rounded-full bg-rose-light"
          />
          {label}
        </span>
      ))}
    </p>
  );
}
