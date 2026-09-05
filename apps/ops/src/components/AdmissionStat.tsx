import { LiveNumber } from "./LiveNumber";

export function AdmissionStat({ label, value, people }: { label: string; value: number; people: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="admission-stat-value">
        <LiveNumber value={value} />
        <small><LiveNumber value={people} /> {people === 1 ? "person" : "people"}</small>
      </dd>
    </div>
  );
}
