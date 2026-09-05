import { LiveNumber } from "./LiveNumber";

export function AdmissionStat({ label, value, people, selected, onSelect }: {
  label: string;
  value: number;
  people: number;
  selected?: boolean;
  onSelect?: (() => void) | undefined;
}) {
  return (
    <div className={onSelect ? "admission-stat-filter" : undefined}>
      <dt>{onSelect ? (
        <button
          type="button"
          aria-pressed={selected ?? false}
          aria-label={`${label}: ${value} teams, ${people} ${people === 1 ? "person" : "people"}`}
          onClick={onSelect}
        >{label}</button>
      ) : label}</dt>
      <dd className="admission-stat-value">
        <LiveNumber value={value} />
        <small><LiveNumber value={people} /> {people === 1 ? "person" : "people"}</small>
      </dd>
    </div>
  );
}
