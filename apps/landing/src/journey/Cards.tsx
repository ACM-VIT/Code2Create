import { FAN, WEDGES, WEDGE_FILLS } from './cardLayout.js';

/** The emblem itself, inline so its shell can outlive its wedges. */
export function Emblem() {
  return (
    <svg
      className="emblem"
      viewBox="0 0 150 163.825"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g className="emblem__shell">
        <path
          d="M67.8476 1.85843L7.1455 35.8758C2.71945 38.3537 0 42.9325 0 47.8883V115.923C0 120.879 2.71945 125.458 7.1455 127.936L67.8476 161.953C72.2736 164.431 77.7125 164.431 82.1386 161.953L142.841 127.936C147.267 125.458 149.986 120.879 149.986 115.923V47.8883C149.986 42.9325 147.267 38.3537 142.841 35.8758L82.1524 1.85843C77.7264 -0.619478 72.2736 -0.619478 67.8476 1.85843Z"
          fill="#FAFBFB"
        />
        <path
          d="M140.107 118.401V45.4238L74.9931 8.92853L9.87885 45.4238V118.401L74.9931 154.883L140.107 118.401Z"
          fill="#2C2C2C"
          stroke="#B44F76"
          strokeWidth="0.343065"
          strokeMiterlimit="10"
        />
      </g>

      <g className="emblem__wedges">
        {WEDGES.map((wedge, index) => (
          <path
            key={index}
            d={`M${wedge.points.map((point) => point.join(' ')).join('L')}Z`}
            fill={wedge.fill}
          />
        ))}
      </g>
    </svg>
  );
}

const FACES = [
  '/assets/svg/card-ace.svg',
  '/assets/svg/card-king.svg',
  '/assets/svg/card-queen.svg',
  '/assets/svg/card-jack.svg',
  '/assets/svg/card-10.svg',
];

export default function Cards() {
  return (
    <div className="cards" aria-hidden="true">
      {FAN.map((_slot, index) => (
        <div className="card" key={index} data-card={index}>
          <div className="card__wedge" style={{ background: WEDGE_FILLS[index] }} />
          <div className="card__face">
            <img className="card__scan" src={FACES[index]} alt="" />
          </div>
        </div>
      ))}
    </div>
  );
}
